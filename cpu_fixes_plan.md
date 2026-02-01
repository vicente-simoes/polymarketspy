# CPU Fixes Plan (2026-01)

This plan addresses the CPU saturation described in `cpu_problem.md` by redesigning the “hot paths” so that:

- **All runtime reads are bounded** (no unbounded history scans).
- **All expensive computation moves to background / write-time** (precomputed caches).
- **Table growth is controlled** (retention windows).

The largest wins come from:
1) removing `SHADOW_USER` (write amplification + per-user snapshot loops), and  
2) eliminating “latest price” reads from `MarketPriceSnapshot` (which can silently degrade into returning a huge history).

---

## 1) What’s causing the CPU issues today

### A. `MarketPriceSnapshot` read pattern can become unbounded
`MarketPriceSnapshot` is a time-series table keyed by `(assetId, bucketTime)` with many rows per asset. A query shaped like:

```sql
SELECT id, assetId, midpointPriceMicros
FROM "MarketPriceSnapshot"
WHERE assetId IN (...)
```

…returns **all historical rows** for those assets unless the query *guarantees* “1 row per asset” at the SQL level.

Even when the code intends to dedupe via Prisma `distinct`, the observed production query in `cpu_problem.md` shows the unbounded shape (no limit / no distinct), which is consistent with “fetch many then dedupe elsewhere” and will peg CPU as data grows.

### B. Hot loops + polling multiply the load
- Worker and web endpoints both query prices frequently.
- The dashboard polls several endpoints every ~10 seconds.
- Worker queue concurrency is high enough to multiply DB work under load.

### C. `SHADOW_USER` amplifies writes and periodic compute
Today we:
- Write shadow ledger entries for each ingested event.
- Compute per-user snapshots every minute (plus global + per-user attribution snapshots).

This increases:
- total writes,
- number of rows to aggregate over time,
- the number of “held assets across any portfolio” (which increases price-update fanout).

---

## 2) Goals (functional + performance)

### Functional
- Dashboard shows:
  - current held positions and their PnL (up/down),
  - equity / “true PnL” history over time,
  - per-position drilldown listing the copy attempts involving that `assetId` (as it exists today).

### Performance / reliability
- No unbounded `MarketPriceSnapshot` reads.
- No per-request `groupBy` over `LedgerEntry` for dashboard endpoints.
- Background jobs are bounded and low concurrency.
- Tables do not grow without retention limits.
- System remains stable on a small droplet (2 vCPU / 4GB) with predictable load.

---

## 3) Core strategy (what we’re changing)

### A. Remove `SHADOW_USER` portfolios entirely
Stop writing and maintaining shadow portfolios.

Implications:
- Removes a large source of DB writes.
- Removes per-user shadow snapshot computations.
- Removes the dependency of budgeted dynamic sizing on `SHADOW_USER` exposure.

Decision for now: **If budgeted dynamic is too hard to redesign, remove the setting.**

### B. Replace `MarketPriceSnapshot` “latest” reads with a guaranteed current-price table
Introduce a table that guarantees **1 row per asset**:

**`CurrentPrice`**
- `assetId` (PK/unique)
- `midpointPriceMicros`
- `updatedAt`

All code that needs a price uses `CurrentPrice` instead of `MarketPriceSnapshot`.

We may keep `MarketPriceSnapshot` temporarily for debugging, but it must not be on hot read paths and must have retention if still written.

### C. Add backend caches for “current positions”
Stop recomputing positions from the full ledger on every request/loop by materializing:

**`CurrentPosition` (global)**
- `assetId` (PK/unique)
- `shareMicros` (sum of share deltas)
- `netCashFlowMicros` (sum of cash deltas)
- `marketId` (optional, to avoid repeated joins)
- `updatedAt`

**`CurrentPositionByLeader` (global attribution)**
- `(assetId, followedUserId)` (unique)
- `shareMicros`
- `netCashFlowMicros`
- `updatedAt`

This supports:
- fast portfolio pages,
- fast risk checks (exposure by leader),
- “multiple leaders buy the same asset” naturally (multiple rows per `assetId`).

### D. Add a backend cache for cash + contributed capital
To compute “true PnL” (equity excluding deposits), keep one-row global state:

**`GlobalPortfolioState`**
- `id = "EXEC_GLOBAL"` (or `portfolioScope`)
- `cashMicros`
- `contributedCapitalMicros` (initial bankroll + net deposits)
- `updatedAt`

This allows equity to be computed from:

`equity = cash + Σ(positionValue)`
`pnl = equity - contributedCapital`

### E. Replace `PortfolioSnapshot` with precomputed equity points (multi-resolution)
Instead of storing full portfolio snapshots and computing equity curves from expensive queries, write precomputed equity/PnL points:

**`EquityPoint`**
- `granularity` (enum): `1m`, `20m`, `2h`, `12h`, `1d`
- `bucketTime`
- `equityMicros`
- `contributedCapitalMicros`
- `pnlMicros`
- `updatedAt`
- unique `(granularity, bucketTime)`

Update policy:
- Always write `1m` points.
- Only write `20m/2h/12h/1d` when the current time hits the corresponding boundary (“close” of the interval).

Requested chart resolutions:
- 1h view → `1m`
- 24h view → `20m`
- 7d view → `2h`
- 30d view → `12h`
- all-time → `1d`

### F. Retention windows (keep tables small forever)
Add retention cleanup jobs so time-series tables don’t grow unbounded.

Suggested defaults (tunable):
- `EquityPoint(1m)`: keep 2–7 days
- `EquityPoint(20m)`: keep 60–90 days
- `EquityPoint(2h)`: keep 12–18 months
- `EquityPoint(12h)`: keep 3–5 years
- `EquityPoint(1d)`: keep forever

If `MarketPriceSnapshot` remains:
- Either stop writing it, or keep a short retention window (e.g., 7 days) and never read it on hot paths.

### G. Slow/limit “non-trade” reads
After caches are in place, we can reduce DB read pressure further by:
- increasing dashboard polling intervals (e.g., 10s → 30–60s),
- adding short TTL response caching for heavyweight endpoints (optional once reads are bounded),
- lowering BullMQ worker concurrency for DB-heavy queues.

---

## 4) Key code-path changes (high level)

### Worker write path (execution)
When a copy attempt executes and we write the global `LedgerEntry` row:
- update `CurrentPosition` for that `assetId`
- update `CurrentPositionByLeader` for `(assetId, followedUserId)`
- update `GlobalPortfolioState.cashMicros`

Important: maintain idempotency. Ledger entries are idempotent by unique `(portfolioScope, refId, entryType)`; cache updates must not double-apply.

### Worker price updater
Periodically:
- read held assets from `CurrentPosition` where `shareMicros != 0`
- fetch prices
- upsert into `CurrentPrice`

### Worker equity-point updater
Every minute:
- read `GlobalPortfolioState` for `cashMicros` + `contributedCapitalMicros`
- read held positions from `CurrentPosition`
- read prices from `CurrentPrice`
- compute `equityMicros` and `pnlMicros`
- write `EquityPoint` at the current bucket(s)

### Web endpoints
Rewrite dashboard endpoints to use caches:
- Portfolio pages: `CurrentPosition` + `CurrentPrice` + metadata.
- Equity chart: `EquityPoint` for the requested granularity/range.
- Position drilldown: keep the current behavior (table of copy attempts for that `assetId`) by querying `LedgerEntry` (refId `copy:*`) and joining to `CopyAttempt` / `FollowedUser`.

---

## 5) Operational guardrails (to prevent regressions)

- Add explicit “no-unbounded-query” rules for critical tables (especially anything time-series):
  - Always filter by time window or guarantee 1 row per key in SQL.
- Lower worker concurrency for DB-heavy queues.
- Enable `pg_stat_statements` and track top queries over time.
- Consider a reasonable `statement_timeout` for web requests so a bad query can’t peg CPU indefinitely.

---

## 6) What we’re explicitly NOT doing (for now)

- No exact “open-lot” matching of which buy attempts are still open after sells.
  - The drilldown remains “all copy attempts involving this assetId”, which is what you want today.
- No historical per-leader equity curves (possible later).
- No dependence on `SHADOW_USER` for sizing; budgeted dynamic can be removed until redesigned.

