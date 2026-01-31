# Copy Attempt “Lag” (Multi‑Second) — Fix Plan

## What the problem is (current behavior)

On the **Copy Attempts** page, the “time” column is not “how long the executor took”.

It is computed as:

- `copyLagMs = CopyAttempt.createdAt - windowStart` (where `windowStart` is parsed out of `groupKey`)
- For aggregator copy attempts, `windowStart` is bucketed from the **trade detect time** (250ms buckets).

So a multi‑second value means: **the CopyAttempt row was created seconds after the group’s windowStart**, not that “React rendered slowly” or “aggregation took seconds”.

### Confirmed root cause (from production logs)

For a slow attempt:

- `aggregator` flushes the group at `17:50:14.845Z`
- `executor` logs decision inputs at `17:50:26.329Z` (~11.5s later)
- That attempt shows `bookSource: "REST"`

This indicates the job spent most of its time waiting on the **order book fetch** path:

1. Executor calls `getBook(tokenId, { waitMs: 500, freshnessMs: 2000 })`
2. WS cache can’t provide a fresh snapshot (or token wasn’t subscribed / no update yet)
3. It falls back to **REST** `fetchOrderBook(tokenId)`
4. REST book requests are scheduled through the shared **low‑priority Bottleneck limiter**

At the same time, the “price refresh loop” is doing ~500 REST `/book` calls per refresh cycle to update `CurrentPrice`:

- `assetCount` ~510+ per cycle
- each cycle takes minutes
- the cycle is scheduled every 120s, so **runs can overlap**

Result: the low‑priority limiter queue stays saturated, and when the executor must fall back to REST, its REST request can sit behind hundreds of background price requests → **5–15s copy lag**.

## Fixes we will implement (no “shrink assetCount”)

We will fix the lag without changing the definition of “held assets” (no dust threshold / no assetCount shrinking).

### Fix 1 — Priority for executor REST book fetches

Goal: if we must fall back to REST for a copy attempt, it should not wait behind background price refresh work.

Implementation approach:

- Keep a single Bottleneck limiter for CLOB REST requests (so we still respect total rate limits),
  but **use Bottleneck priorities**:
  - executor REST book fetch: **high priority**
  - price refresh REST book fetch: **low priority**

This guarantees that “critical” REST book fetches jump ahead of the background queue instead of waiting minutes.

### Fix 2 — Prevent overlapping price refresh cycles

Goal: ensure only one price refresh run is active at a time.

Implementation approach:

- Add an `inFlight` guard (or convert the loop to `setTimeout` chaining) so that a refresh that takes longer than the interval
  cannot overlap and compound the REST backlog.

### Fix 3 — Reduce or eliminate REST usage for prices (WS-first)

Goal: stop flooding the REST `/book` endpoint for prices on a large portfolio.

Practical constraint: our current WS subscription mechanism is tied to the order book cache size (`maxActiveBooks`).
With ~500 held assets and a default cache size of ~200, we cannot simply “subscribe to everything” without either:

- increasing cache capacity (memory trade-off), or
- decoupling subscriptions from full-book storage, or
- maintaining a separate lightweight “mid-price cache”.

Implementation approach (recommended):

- Introduce a **lightweight mid-price cache** fed by WS updates (best bid/ask → midpoint).
- Update `CurrentPrice` from that cache on a timer (or in small batches), instead of REST-fetching all books.
- Keep REST as a *rare* fallback only for tokens that have never received a WS update (optional; can be disabled if we truly want “no REST for prices”).

This preserves full book depth for the executor path (when needed) while making price refresh cheap.

## Step-by-step implementation plan

### Phase 0 — Add “copy lag” observability (optional but recommended)

1. Add a log field for executor book fetch source (`WS` vs `REST`) and elapsed time spent in `getBook`.
2. Add a log field for “time since group windowStart” when writing CopyAttempt (so we can validate the UI lag source).

Success criteria:
- For slow UI rows, logs show where time is spent (REST queue wait vs DB vs execution).

### Phase 1 — Priority-based limiter for CLOB REST

Code changes:

1. `apps/worker/src/http/limiters.ts`
   - Ensure the low-priority limiter supports Bottleneck priorities via `schedule({ priority: ... }, fn)`.
   - Define two priority constants (e.g. `CLOB_PRIORITY_EXECUTOR = 0`, `CLOB_PRIORITY_BACKGROUND = 9`).

2. `apps/worker/src/poly/client.ts`
   - Update `clobApiRequest()` to accept an optional `priority` argument (default to background if omitted).
   - Update `fetchOrderBook(tokenId)` to accept an optional `{ priority }` option and pass it down.
   - Update `fetchPrices(tokenIds)` to call `fetchOrderBook(tokenId, { priority: CLOB_PRIORITY_BACKGROUND })`.

3. `apps/worker/src/simulate/bookService.ts`
   - Update the REST fallback call to use `fetchOrderBook(tokenId, { priority: CLOB_PRIORITY_EXECUTOR })`.

Tests / validation:

1. Local repro: run worker with a large `assetCount` and trigger copy attempts that fall back to REST.
2. Confirm that even when price refresh is running, REST-backed copy attempts do not show 5–15s lags.
3. In logs, confirm executor REST book fetches are not delayed behind background requests.

### Phase 2 — Make price refresh non-overlapping

Code changes:

1. `apps/worker/src/snapshot/prices.ts`
   - Add a module-level `priceRefreshInFlight` guard (same pattern as the equity tick loop).
   - If a scheduled tick fires while in flight, skip.
   - (Optional) replace `setInterval` with “run then `setTimeout`” scheduling for cleaner behavior.

Tests / validation:

1. Temporarily lower the interval in dev and log `refresh start/finish`.
2. Confirm only one refresh runs at a time.

### Phase 3 — WS-first (mid-price cache) for prices

Code changes:

1. Add a new module, e.g. `apps/worker/src/snapshot/midPriceCache.ts`
   - Store `Map<tokenId, { midpointPriceMicros, updatedAtMs }>`
   - Expose:
     - `updateMidPrice(tokenId, midpointPriceMicros, updatedAtMs)`
     - `getMidPrice(tokenId)`
     - `getStats()`

2. `apps/worker/src/clob-ws/ClobBookWsClient.ts`
   - When a WS book update is processed, compute midpoint from best bid/ask and call `updateMidPrice(...)`.
   - Keep the existing full-book cache behavior unchanged for the executor.

3. `apps/worker/src/snapshot/prices.ts`
   - Replace the REST loop (`fetchPrices`) with:
     - ensure WS subscriptions for held assets (in chunks; avoid burst subscribe messages)
     - read midpoint prices from `midPriceCache`
     - upsert `CurrentPrice` for tokens with a known midpoint
   - Optional fallback policy:
     - **Strict “no REST for prices”**: if no midpoint exists, keep existing `CurrentPrice` unchanged.
     - **Hybrid**: for tokens missing WS midpoints for >N minutes, fetch REST in background priority (still non-blocking to executor due to Phase 1).

4. `apps/worker/src/health/server.ts`
   - Extend `/health` to include mid-price cache stats:
     - cache size, fresh count, subscribed count (if available)

Tests / validation:

1. Confirm `/health` shows WS connected and mid-price cache filling.
2. Confirm price refresh no longer generates hundreds of REST `/book` calls.
3. Confirm copy attempts no longer show multi-second lag even when WS mid-price caching is enabled.

## Rollout / deployment checklist

1. Deploy Phase 1 + Phase 2 first (these alone should fix the lag symptom).
2. Monitor:
   - Copy Attempt “lag” distribution (UI)
   - `bookSource` mix (WS vs REST) in worker logs
   - frequency and duration of price refresh runs
3. If REST volume is still undesirable, deploy Phase 3.

