# CPU Fixes Implementation Steps

This is an ordered, end-to-end checklist for implementing the fixes described in `cpu_fixes_plan.md`. The goal is that after completing all steps (including tests + deployment), the app runs without CPU saturation from DB hot queries.

---

## Phase 0 — Baseline + guardrails (before changing code)

1) Confirm current production symptoms match `cpu_problem.md`.
   - Capture: `docker stats`, `pg_stat_activity` (hot query), and approximate request rate to dashboard endpoints.
2) Add a short-term safety guard in production (ops-only) if needed:
   - lower worker concurrency (BullMQ) and/or reduce web polling.
   - this is a temporary mitigation until caches ship.

---

## Phase 1 — Database schema: add bounded “current state” tables

3) Add Prisma models + migrations for:
   - `CurrentPrice(assetId PK, midpointPriceMicros, updatedAt)`
   - `CurrentPosition(assetId PK, shareMicros, netCashFlowMicros, marketId?, updatedAt)`
   - `CurrentPositionByLeader(assetId, followedUserId, shareMicros, netCashFlowMicros, updatedAt)` with unique `(assetId, followedUserId)`
   - `GlobalPortfolioState(id PK, cashMicros, contributedCapitalMicros, updatedAt)`
   - `EquityPoint(granularity, bucketTime, equityMicros, contributedCapitalMicros, pnlMicros, updatedAt)` with unique `(granularity, bucketTime)`

4) Add indexes explicitly for the access patterns:
   - `EquityPoint(granularity, bucketTime DESC)`
   - `CurrentPosition(shareMicros)` if you filter held assets by `shareMicros != 0` frequently (or just scan if small).
   - For drilldown performance: a composite index on `LedgerEntry` that matches queries like:
     - `(portfolioScope, assetId, entryType, createdAt DESC)`

5) Decide what to do with old tables:
   - `PortfolioSnapshot`: plan to stop writing + stop reading; keep temporarily for rollback.
   - `MarketPriceSnapshot`: stop reading on hot paths; optionally stop writing entirely or apply retention.

---

## Phase 2 — Write-path caching (make updates cheap and incremental)

6) Implement cache updates whenever the global ledger changes.

Target behavior:
- When a global `LedgerEntry` is newly created (trade fill):
  - Update `CurrentPosition` for `assetId`:
    - `shareMicros += shareDeltaMicros`
    - `netCashFlowMicros += cashDeltaMicros`
  - Update `CurrentPositionByLeader` for `(assetId, followedUserId)` similarly.
  - Update `GlobalPortfolioState.cashMicros += cashDeltaMicros`

- When a DEPOSIT ledger entry is created:
  - Update `GlobalPortfolioState.cashMicros += depositAmount`
  - Update `GlobalPortfolioState.contributedCapitalMicros += depositAmount`

Important implementation detail (idempotency):
- The existing ledger write is an upsert keyed by `(portfolioScope, refId, entryType)`.
- The cache updates must only apply **once** per unique ledger entry.
- Implement by either:
  - creating ledger entry first (create + unique constraint), and only then updating caches, or
  - wrapping in a transaction that detects “did we insert a new row?” before applying cache deltas.

7) Add a one-time backfill script/command to initialize caches from existing data:
   - Build `CurrentPosition` from `LedgerEntry` aggregate grouped by `assetId`.
   - Build `CurrentPositionByLeader` from `LedgerEntry` aggregate grouped by `(assetId, followedUserId)` for `refId` starting with `copy:`.
   - Initialize `GlobalPortfolioState` from configured initial bankroll + DEPOSIT ledger entries + trade cash deltas.
   - Initialize `CurrentPrice` either by:
     - copying latest known price per asset (if you keep `MarketPriceSnapshot`), or
     - fetching prices once for held assets.

---

## Phase 3 — Replace price snapshots with guaranteed “current price”

8) Modify the price refresh loop:
   - Determine held assets from `CurrentPosition` (where `shareMicros != 0`).
   - Fetch prices.
   - Upsert into `CurrentPrice`.
   - Stop writing `MarketPriceSnapshot` (or keep it only for debugging with retention).

9) Update all code paths that currently read prices from `MarketPriceSnapshot`:
   - Worker risk checks / exposures (copy executor).
   - Web endpoints that render positions and overview.
   - Replace with a join/lookup into `CurrentPrice`.

Success criterion:
- There is **no** runtime query that can return an unbounded history from a time-series table.

---

## Phase 4 — Replace portfolio snapshots with equity points (multi-resolution)

10) Implement an equity-point writer loop (worker):
   - Runs every minute.
   - Reads `GlobalPortfolioState` for `cashMicros` and `contributedCapitalMicros`.
   - Reads held positions from `CurrentPosition` and marks them using `CurrentPrice`.
   - Computes:
     - `equityMicros = cash + Σ(shares * price)`
     - `pnlMicros = equity - contributedCapital`
   - Upserts `EquityPoint` rows:
     - always for `1m`
     - additionally for `20m`, `2h`, `12h`, `1d` at boundaries (“close”).

11) Add retention cleanup (daily job) for `EquityPoint`:
   - delete old rows per granularity window.
   - keep daily points forever.

---

## Phase 5 — Remove `SHADOW_USER` + disable/remove budgeted dynamic

12) Remove shadow ledger writes:
   - Stop calling `applyShadowTrade` / `applyShadowActivity`.
   - Delete or disable the shadow portfolio worker module(s).
   - Ensure ingest still enqueues events for aggregation/execution as needed.

13) Remove per-user snapshot computations:
   - Stop the portfolio snapshot loop that iterates all followed users.
   - Stop writing `PortfolioSnapshot` (or keep only for rollback temporarily).

14) Remove budgeted dynamic dependency on `SHADOW_USER`:
   - Short-term (recommended): remove/disable budgeted dynamic sizing mode and its UI/settings.
   - Update worker sizing logic and API endpoints that surface budgeted-dynamic fields.
   - Update tests accordingly (remove or rewrite budgeted-dynamic tests).

---

## Phase 6 — Update web APIs + UI to read bounded caches

15) Rewrite these endpoints to use caches instead of ledger `groupBy` + price snapshots:
   - `/api/portfolio/global`: read `CurrentPosition` + `CurrentPrice` + token metadata.
   - `/api/overview`: read `EquityPoint` for chart + latest point for metrics.
   - `/api/markets`: for market detail positions, use `CurrentPosition` filtered by market or asset IDs, not ledger aggregation.

16) Keep the position drilldown behavior:
   - Query the list of copy attempts that have the assetId by:
     - querying `LedgerEntry` for `(EXEC_GLOBAL, assetId, entryType=TRADE_FILL, refId startsWith "copy:")`,
     - extracting `copyAttemptId`,
     - selecting `CopyAttempt` + `FollowedUser` label.

17) Reduce dashboard polling to a safer baseline (optional but recommended):
   - Increase SWR `refreshInterval` (e.g. 10s → 30–60s).
   - Or poll only while the tab is visible / on focus.

---

## Phase 7 — Worker concurrency + query safety

18) Lower BullMQ worker concurrency for DB-heavy queues.
   - Target: 1–2 for copy execution / aggregation paths unless proven safe.
   - Recommended knobs (env):
     - `WORKER_CONCURRENCY_DEFAULT` (default 2)
     - `WORKER_CONCURRENCY_GROUP` (default 1)
     - `WORKER_CONCURRENCY_COPY_GLOBAL` (default 1)
     - `WORKER_CONCURRENCY_INGEST` (default 2)
     - `WORKER_CONCURRENCY_RECONCILE` (default 1)

19) Add query guardrails:
   - Ensure no “IN list against time-series without limit/window”.
   - Optionally set `statement_timeout` for web queries.
   - Add a small backend TTL cache for hot dashboard endpoints so polling doesn’t translate into constant DB load.

---

## Phase 8 — Testing (must pass before deployment)

20) Unit tests:
   - cache idempotency: repeated events do not double-apply.
   - equity computation: equity + pnl are correct with deposits + trades.
   - retention: old `EquityPoint` rows are deleted as expected.
   - Suggested commands:
     - `pnpm -C apps/worker test`
     - `pnpm -C apps/worker typecheck`
     - `pnpm -C apps/web exec tsc --noEmit --incremental false` (avoid `tsconfig.tsbuildinfo` writes)

21) Integration tests / local run:
   - Run worker + web locally against a seeded DB.
   - Verify endpoints:
     - positions page returns quickly and reflects trades,
     - chart shows correct points across ranges,
     - position drilldown lists copy attempts for that asset.

22) Performance sanity:
   - Confirm queries are bounded (row counts small, no long-running `MarketPriceSnapshot` reads).
   - Confirm CPU remains stable under normal polling.

---

## Phase 9 — Deployment + rollout

23) Deploy schema changes first (migrations), then deploy code.
24) Run backfill once on production to initialize caches.
25) Turn on worker loops (price updater + equity point writer).
26) Monitor:
   - top queries in Postgres,
   - CPU graphs,
   - queue depths,
   - error rates.

Rollback plan:
- If needed, temporarily re-enable old endpoints/snapshots, but keep the new bounded tables intact to retry.
