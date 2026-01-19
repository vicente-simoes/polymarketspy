# Book Subscription Implementation Plan (Polymarket CLOB)

## Why this is needed
We currently fetch the CLOB order book via REST (`/book`) during each copy attempt and assume:

- `book.bids[0]` is the best bid
- `book.asks[0]` is the best ask
- levels are sorted and representative

Real logs show “impossible” top-of-book like:

- best bid `$0.01`, best ask `$0.99`, mid `$0.50`, spread `$0.98`

That creates systematic skips (`SPREAD_TOO_WIDE`, `INSUFFICIENT_DEPTH`, `NO_LIQUIDITY_WITHIN_BOUNDS`) even when the market is liquid.

There are two likely causes:
1) The REST book payload is not reliably sorted (so `[0]` isn’t best), and our simulation breaks early.
2) REST book can be stale/ghosty under load; we need a fresher feed.

**Proposed fix:** Make a WebSocket L2 book feed the primary source of book state, maintain an in-memory snapshot per tokenId, and only use REST as a fallback.

## Target behavior (definition of success)
For a detected leader trade:
1) Copy attempt created immediately.
2) We evaluate copying using a **fresh** L2 book snapshot.
3) If within rules, we execute (place order) and record fills + ledger entry.
4) If not, we skip with reasons that reflect real market conditions.
5) The “absurd book” symptom disappears unless it is truly the market state.

## Scope of this plan
This plan covers:
- Maintaining accurate L2 books per tokenId (WS primary, REST fallback).
- Correct best bid/ask/mid/spread computation (never trust ordering).
- Feeding the snapshot into fill simulation and guardrails.
- Instrumentation and tests so it stays correct.

This plan **does not** change trade sizing or guardrail policy (that’s a separate decision), and it assumes the execution path (placing orders) exists or will be implemented separately.

---

## Phase 0: Confirm Polymarket CLOB WS details (required)
Before writing code, determine:

- **WS endpoint** (e.g., `wss://…`) and whether it is public or requires auth.
- **Subscription model**:
  - Subscribe per `tokenId` vs per `marketId`/`conditionId`.
  - Snapshot + delta messages (L2) vs periodic full snapshots only.
- **Message schema**:
  - How bids/asks are encoded (price strings, size strings).
  - Whether deltas use “set size at price” semantics.
- **Rate/connection limits**:
  - Max subscriptions per connection, max connections, ping/pong requirements.

Deliverable: a short note (or comments in code) describing the exact WS contract and an example message.

---

## Phase 1: Fix book correctness regardless of source (WS or REST)
Even with WS, we must never assume ordering. Implement book utilities that:

- Convert levels to micros (`priceMicros`, `sizeMicros`).
- Compute:
  - `bestBidMicros = max(bids.priceMicros)`
  - `bestAskMicros = min(asks.priceMicros)`
  - `midPriceMicros = round((bestBid + bestAsk) / 2)`
  - `spreadMicros = bestAsk - bestBid`
- Produce **sorted** arrays for simulation:
  - BUY consumes asks ascending by price
  - SELL consumes bids descending by price

This should become the single canonical way to interpret any book payload.

Deliverable: a `bookUtils` helper with unit tests proving correctness on:
- Unsorted inputs
- Sparse books (missing bids or asks)
- Books containing “dust” orders at extremes

---

## Phase 2: Add an in-memory OrderBookCache keyed by `tokenId`
### Data model
Define a normalized in-memory representation:

- `OrderBookSnapshot`:
  - `tokenId: string`
  - `bids: Array<{ priceMicros: number; sizeMicros: bigint }>`
  - `asks: Array<{ priceMicros: number; sizeMicros: bigint }>`
  - `bestBidMicros`, `bestAskMicros`, `midPriceMicros`, `spreadMicros`
  - `updatedAt: number` (ms epoch)
  - `source: "WS" | "REST"`

### Cache rules
Add operational parameters (configurable via env or DB later):

- `MAX_ACTIVE_BOOKS` (e.g., 200)
- `BOOK_TTL_MS` since last use (e.g., 10 minutes)
- `FRESHNESS_MS` since last update (e.g., 2–5 seconds)
- `FIRST_SNAPSHOT_WAIT_MS` (e.g., 300–800ms)

### Cache API
Expose a small API used by the simulation path:

- `touch(tokenId)` marks “recently used” for LRU/TTL.
- `get(tokenId): OrderBookSnapshot | null`
- `getFreshOrWait(tokenId, opts): Promise<OrderBookSnapshot | null>`
  - If snapshot fresh → return immediately
  - Else ensure subscribed and wait up to `FIRST_SNAPSHOT_WAIT_MS`
  - If still not fresh → return `null` (caller may REST fallback)
- `evictExpired()` runs periodically to unsubscribe and free memory.

Deliverable: a module that can store/update snapshots and enforce TTL/LRU.

---

## Phase 3: Implement the Polymarket CLOB Book WebSocket client
### Connection management
Implement a `ClobBookWsClient` that:

- Opens a WS connection to the CLOB book feed.
- Reconnects with exponential backoff on errors.
- On reconnect, re-subscribes to all active tokenIds.
- Implements ping/pong or heartbeat if required.

### Subscription lifecycle
The client should support:

- `ensureSubscribed(tokenId)`:
  - if not subscribed, send subscribe message, create empty state
  - track reference counts or “last used”
- `unsubscribe(tokenId)` on TTL expiry

### Book updates
Depending on the WS contract:

- If WS provides a **full snapshot** message:
  - Replace cached book state for that token.
- If WS provides **deltas**:
  - Apply delta updates into a map structure:
    - `Map<priceMicros, sizeMicros>` for bids and asks
  - Remove a level when size becomes 0.
  - Periodically re-compact to arrays for simulation/metrics.

After every update:
- Recompute best bid/ask using max/min across all levels.
- Stamp `updatedAt`.
- Emit an event to wake any `getFreshOrWait()` callers.

Deliverable: a WS client + integration with `OrderBookCache`.

---

## Phase 4: Integrate cache snapshots into simulation/executor
### Replace “fetch book now” with “get snapshot”
In the copy attempt decision path:

1. Determine `tokenId` for the trade group (already exists).
2. Call `bookCache.getFreshOrWait(tokenId)`:
   - If returns snapshot: use it (source = WS).
   - Else: REST fallback:
     - call existing REST `fetchOrderBook(tokenId)`
     - normalize + sort via Phase 1 utilities
     - store snapshot in cache (source = REST, updatedAt=now)

### Ensure simulation uses sorted levels
Feed the normalized sorted snapshot into simulation:

- BUY consumes asks ascending
- SELL consumes bids descending

Do not allow simulation to depend on array ordering from upstream.

### “Freshness gate”
If WS snapshot isn’t fresh:
- wait briefly (bounded) for next update (Phase 2)
- then fall back to REST if needed

Deliverable: copy attempts always run against a sane snapshot and log which source was used.

---

## Phase 5: Add diagnostics and safety checks (so we can trust it)
### Mandatory per-attempt logging fields
For every copy attempt, log:

- `tokenId`, `source` (WS vs REST)
- `bestBid`, `bestAsk`, `mid`, `spread`
- `bounds` used (`maxPrice`/`minPrice`)
- `availableNotionalWithinBounds`, `filledShare`, `filledNotional`, `filledRatioBps`
- `bookUpdatedAtAgeMs` (now - updatedAt)

### Sanity checks (recommended)
If the computed spread is “insane” (e.g., `> $0.20`) or if depth within bounds is zero:

- Optionally perform a one-shot REST fetch to confirm.
- If REST and WS disagree strongly:
  - mark WS snapshot invalid/stale for this token and resubscribe/rebuild

Deliverable: a clear audit trail that explains each SKIP/EXECUTE decision with trustworthy book data.

---

## Phase 6: Tests (must-have)
### Unit tests
Add tests for:
- Best bid/ask computation on unsorted books.
- Delta application correctness (set/remove levels).
- Sorting correctness for simulation.

### Integration tests (mock WS)
Simulate:
- Subscribe → snapshot message → copy attempt uses WS snapshot.
- Snapshot stale → wait timeout → REST fallback.
- Reconnect → resubscribe → book continues updating.

Deliverable: tests that would have caught the `0.01 / 0.99` “best” bug.

---

## Phase 7: Operational rollout plan
### Feature flag
Add an env toggle:
- `CLOB_BOOK_WS_ENABLED=true|false`

Behavior:
- If disabled: keep REST path but still use Phase 1 sorting + best bid/ask computation.
- If enabled: WS primary + REST fallback.

### Capacity controls
Set conservative defaults:
- `MAX_ACTIVE_BOOKS=200`
- `BOOK_TTL_MS=10m`
- `FRESHNESS_MS=2s`
- `FIRST_SNAPSHOT_WAIT_MS=500ms`

Deliverable: safe deployment without “subscription explosion”.

---

## Notes / expected outcome vs current logs
After Phase 1 + Phase 4, even without WS you should no longer see:
- best bid = `$0.01` solely because `bids[0]` was `$0.01`
- best ask = `$0.99` solely because `asks[0]` was `$0.99`

After WS is enabled, decision books should be fresher, reducing “ghost book” effects and lowering latency.

If you still see a large spread after these changes, it is more likely to be real (or a tokenId mapping issue), not an artifact of ordering/staleness.

---

## Final “Done” checklist
- Copy attempts log a realistic best bid/ask for liquid markets.
- Depth within bounds is non-zero when the market is actually tradable.
- `SPREAD_TOO_WIDE / INSUFFICIENT_DEPTH / NO_LIQUIDITY_WITHIN_BOUNDS` only trigger when liquidity truly isn’t available within configured bounds.
- WS book snapshot is used for most attempts; REST is only a fallback.
- Reconnect/resubscribe behavior is stable and does not leak subscriptions.

