# Large Queues + “Detect Lag = 0ms” Fix

This document captures what went wrong on the droplet deployment, why it degrades over time, and a concrete plan to fix it. It also includes “reset-from-scratch” steps you can run after the fixes land.

## Symptoms (as observed in production)

- After running for a while, **trade “Detect Lag” increases**, then many rows **stay at `0ms` forever**.
- **Copy-attempt latency** (from detection to completion) drifts upward (commonly ~2s+).
- Worker health shows **one queue growing without bound**:
  - `/health` → `queueDepths.portfolioApply` ~29k+ and rising, while the other queues remain near 0.

## Key evidence collected

- Worker health:
  - `queueDepths.portfolioApply ≈ 29,5xx` and stable/growing.
- Redis (BullMQ backing store):
  - `LLEN bull:q_portfolio_apply:wait = 29546`
  - `maxmemory = 256mb` and `maxmemory_policy = noeviction` (see `docker/redis.conf`)
- Postgres (WS-first trades never backfilled):
  - `SELECT count(*) ... WHERE source='ONCHAIN_WS' AND "eventTime"="detectTime" AND "detectTime" < now()-interval '5 minutes';`
  - Result: `~5600` (stale WS trades that still have `eventTime=detectTime`)
- WS trade rate vs API fetch limit:
  - For `0xee613…`, WS trades bucketed into 3-minute windows show bursts like **126 trades / 3 minutes**.
  - The poller fetches Data API trades with `limit=100` per request.
- Data API lag window:
  - For `0xee613…`, `SystemCheckpoint` `api:lastTradeTime:<userId>` is **~8 minutes behind wall clock** (staleness `00:08:22`).

## Root causes

### Root cause 1 — `q_portfolio_apply` is produced but never consumed

- **Producer exists**: every trade/activity ingest enqueues a `portfolioApply` job:
  - `apps/worker/src/portfolio/processor.ts` enqueues `queues.portfolioApply.add("update-snapshot", ...)`
- **No consumer exists**: there is no `createWorker(QUEUE_NAMES.PORTFOLIO_APPLY, ...)` anywhere in the worker codebase.
- Effect:
  - Redis stores an ever-growing BullMQ queue (`bull:q_portfolio_apply:*` keys).
  - With `maxmemory=256mb` + `noeviction`, Redis will eventually refuse writes; BullMQ then starts erroring and/or slowing down.
  - Even before maxmemory is hit, continuously enqueuing unconsumed jobs creates steady Redis write load, which can increase overall pipeline latency.

### Root cause 2 — WS trades are inserted with `eventTime=detectTime`, and the intended backfill is lossy

- WS-first canonical trades are inserted with:
  - `eventTime = decoded.detectTime` in `apps/worker/src/alchemy/subscription.ts`
  - This is explicitly done to avoid an extra RPC call for block timestamps.
- The UI “Detect Lag” is computed as `detectTime - eventTime` and clamped, so if the backfill never happens, it stays `0ms` indefinitely.
- The backfill mechanism relies on Polymarket Data API polling:
  - `apps/worker/src/ingest/trades.ts` calls `fetchWalletTrades(..., { after, limit: 100 })`
  - `apps/worker/src/poly/client.ts` states the endpoint returns trades **sorted by timestamp descending** (newest first).
  - When the Data API is delayed by minutes, there can be **>100 trades within the “catch-up” window** (confirmed by 126 trades/3m bursts).
  - In that situation, the poller fetches only the newest 100, advances the checkpoint to the newest timestamp, and **permanently skips older trades still within the catch-up window**.
- Effect:
  - Many WS trades never receive an accurate `eventTime`, so “Detect Lag” stays `0ms`.
  - Any “safety net” that depends on the same API fetch pattern (polling + reconcile backfills) can silently miss trades during high-activity windows.

## Proposed fixes (high confidence)

### Fix A (chosen) — Remove the `portfolioApply` queue leak (Option A1)

- The system already computes portfolio snapshots every minute in `apps/worker/src/snapshot/portfolio.ts`.
- The `portfolioApply` queue currently adds load and data growth but provides no functionality in production (because it’s never consumed).
- We will remove the queue and stop enqueuing its jobs.

### Fix B — Make WS trade `eventTime` correct without depending on the Data API

Preferred solution: use the on-chain **block timestamp** as `eventTime` for WS-first trades.

- When inserting the WS trade, compute `eventTime` as the timestamp of `blockNumber`.
- Cache block timestamps (Map `blockNumber → Date`) to keep the RPC cost bounded.
- This makes “Detect Lag” meaningful even when the Data API lags or is lossy.

### Fix C — Make the Data API ingestion non-lossy (or stop using it as a safety net)

Even with Fix B, the Data API is still useful for:
- discovering proxy wallets,
- enriching metadata,
- catching missed trades if WS is temporarily down.

To make it reliable:
- Confirm what pagination the Data API supports (e.g., `before`, `cursor`, `offset`).
- If pagination exists, implement full paging so you can drain the backlog window, not just 100 trades.
- If pagination does not exist, **do not treat the Data API as a safety net**; instead implement an on-chain backfill using `getLogs` on reconnect (which is paginatable by block range).

## Implementation steps (explicit)

### Step 1 — Remove `q_portfolio_apply` (Option A1)

1. **Stop enqueuing**:
   - Edit `apps/worker/src/portfolio/processor.ts` and remove both calls to `queues.portfolioApply.add("update-snapshot", ...)`.
2. **Remove the queue definition**:
   - Edit `apps/worker/src/queue/queues.ts`:
     - Remove `PORTFOLIO_APPLY` from `QUEUE_NAMES`.
     - Remove `portfolioApply` from the exported `queues` object.
   - This automatically removes it from worker `/health` queue depth computation.
3. **Update the web status endpoint/UI if needed**:
   - `apps/web/src/app/api/status/route.ts` currently reads `queueDepths.portfolioApply`; remove it or make it optional.
4. **Verify locally**:
   - Start the stack and ensure `/health` no longer reports `portfolioApply`, and Redis no longer receives new `bull:q_portfolio_apply:*` keys.

### Step 2 — Set WS trade `eventTime` to the block timestamp

1. Update WS insertion:
   - In `apps/worker/src/alchemy/subscription.ts`, when inserting the canonical WS trade, replace:
     - `eventTime: decoded.detectTime`
   - With:
     - `eventTime: <blockTimestamp>`
2. Implement block timestamp lookup with caching:
   - Maintain a bounded in-memory cache (e.g., LRU or a Map with periodic pruning) keyed by `blockNumber`.
   - Fetch via your provider (`getBlock(blockNumber)`), then convert `block.timestamp` to a `Date`.
   - On failures, fall back to `detectTime` but log + optionally queue a retry to backfill later.
3. Verify:
   - The SQL “stuck WS trades” query returns ~0 for new data.
   - The web “Detect Lag” starts at a real number and does not stay `0ms`.

### Step 3 — Fix Data API ingestion so it can’t skip trades during catch-up windows

1. Confirm Data API pagination and ordering:
   - Use `curl` to validate the response ordering and whether `before`/`cursor` exist.
2. If pagination exists:
   - Extend `fetchWalletTrades()` in `apps/worker/src/poly/client.ts` to accept pagination parameters.
   - Update these ingestion paths to loop pages until exhausted:
     - `apps/worker/src/ingest/trades.ts` (`ingestTradesForUser`)
     - `apps/worker/src/ingest/trades.ts` (`ingestTradesForWalletFast`)
   - Update the checkpoint only after paging completes.
3. If pagination does not exist:
   - Treat the Data API poller as “best-effort enrichment only” (not correctness).
   - Implement on-chain backfill (block-range log scan) for reconnect safety net.

### Step 4 — Validation checklist (after fixes)

After running for an extended period:
- `/health` queue depths remain bounded (no unbounded growth).
- Redis memory stays well below `maxmemory`.
- WS trades no longer match `eventTime=detectTime`:
  - `SELECT count(*) ... WHERE source='ONCHAIN_WS' AND "eventTime"="detectTime" AND "detectTime"<now()-interval '5 minutes'` stays near 0.
- Copy attempt lag returns to the expected range and does not drift upward over time.

## Reset & restart from scratch (manual, destructive)

You said we can assume we’ll reset everything after implementing the fixes. Here is the clean “start from zero” procedure.

**WARNING**: this deletes all Postgres + Redis data.

From the droplet, in the directory that contains the production compose file (commonly `~/apps/polymarketspy/docker`):

1. Stop and delete containers + volumes:
   - `docker compose down -v --remove-orphans`
2. Rebuild the web + worker images:
   - `docker compose build --no-cache web worker`
3. Start only DB + Redis first:
   - `docker compose up -d db redis`
4. Apply database migrations:
   - `docker compose run --rm worker sh -lc 'cd /app && npx prisma migrate deploy'`
5. Start everything:
   - `docker compose up -d`
6. Verify:
   - `curl -sS http://127.0.0.1:8081/health | python3 -m json.tool`
   - `docker exec -e REDISCLI_AUTH=\"$REDIS_PASSWORD\" -it polymarket-redis redis-cli INFO memory | egrep 'used_memory_human|maxmemory_human|mem_fragmentation_ratio'`
