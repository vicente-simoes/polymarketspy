# Copy Trade “Always Skip” — Fix Plan

## Goal (desired behavior)
1. Followed user trade detected
2. Copy attempt created (recorded, idempotent)
3. Connect to CLOB order book to evaluate copy conditions
4. If criteria met → **EXECUTE** (and record simulated fills + ledger entry)
5. If criteria not met → **SKIP** (and record **specific reasons**)
6. If copied, position is reflected in the **global executable portfolio** until:
   - the leader sells and we copy-sell, or
   - the market resolves and we realize P/L (settlement/redemption path)

## What’s happening now
Every copy attempt is being marked **SKIP**, almost always with the same reasons:

- `SPREAD_TOO_WIDE`
- `INSUFFICIENT_DEPTH`
- `NO_LIQUIDITY_WITHIN_BOUNDS`

Even for markets that “obviously” have liquidity.

## Root cause (primary)
### Bug: price bounds computed with `midPriceMicros = 0` (BUYs become impossible)
In `apps/worker/src/simulate/executor.ts`, price bounds are computed **before** the order book is fetched:

- `computePriceBounds(side, theirRef, mid=0, guardrails)` is called, with a comment “will be updated after book fetch” — but it is never updated.
- For BUYs, `computePriceBounds` returns:
  - `maxPriceMicros = min(theirFill + maxWorsening, mid + maxOverMid)`
- With `mid=0`, `mid + maxOverMid` becomes `0.015`, so:
  - **max acceptable BUY price becomes 0.015**

Then `simulateBookFills(...)` stops immediately because the first real ask is always `> 0.015`, which cascades into the “always skip” reasons:

- No levels consumed within bounds → `availableNotionalMicros = 0` → `INSUFFICIENT_DEPTH`
- No fill → `filledShareMicros = 0` → `NO_LIQUIDITY_WITHIN_BOUNDS`
- Spread is still computed from best bid/ask → often also triggers `SPREAD_TOO_WIDE`

This is why you see those three reasons on basically every BUY attempt right now.

### Secondary contributors (after the bug is fixed)
After the mid-price bug is fixed, you may still see a lot of skips due to **real guardrail strictness**:
- Default `maxSpreadMicros = 0.02` can be strict on many Polymarket markets.
- Default `minDepthMultiplierBps = 1.25x` can be strict in thin books (though with tiny target notionals it often won’t matter).

But the “everything always fails” symptom is explained by the mid=0 bug.

## Current implementation map (where to look)
- **Detect + aggregate**: `apps/worker/src/simulate/aggregator.ts`
  - Builds a `TradeEventGroup` and enqueues `q_copy_attempt_global`.
- **Process group**: `apps/worker/src/simulate/workers.ts`
  - Calls `executeCopyAttempt(...)`.
- **Decide + write attempt**: `apps/worker/src/simulate/executor.ts`
  - Computes target size, fetches book, runs guardrails, writes `CopyAttempt`, and if EXECUTE writes `ExecutableFill` + `LedgerEntry`.
- **Book fetch + sim fills**: `apps/worker/src/simulate/book.ts`
  - Calls `fetchOrderBook(tokenId)` and simulates fills against L2.
- **Guardrails**: `apps/worker/src/simulate/guardrails.ts`
  - Spread filter, depth requirement, price protection, risk caps.
- **Portfolio snapshots (global + per-user)**: `apps/worker/src/snapshot/portfolio.ts`
  - Reads `ledgerEntry` to compute positions and equity periodically.

## Fix strategy (high-level)
Compute `midPriceMicros` from the real book **before** computing price bounds, then simulate fills and guardrails using those bounds.

Do this in a way that does **not** double-fetch the book.

## Step-by-step fix plan

### Step 1 — Add one-shot observability (optional but strongly recommended)
Add logs around the decision inputs/outputs so you can sanity-check each attempt quickly:

Log fields to include for each attempt:
- tokenId, marketId, side
- theirRefPriceMicros (`group.vwapPriceMicros`)
- bestBidMicros / bestAskMicros / midPriceMicros / spreadMicros
- computed bounds (max BUY / min SELL)
- targetNotionalMicros, targetShareMicros
- availableNotionalMicros (within bounds), filledNotionalMicros, filledRatioBps
- the final `reasonCodes`

Expected result before the fix: for BUY attempts, you’ll see `maxPriceMicros ≈ 15000`.

### Step 2 — Refactor book simulation to accept a pre-fetched book (avoid double fetch)
Goal: executor should fetch the book once, compute mid/spread, compute bounds, and simulate fills against that same book.

Recommended approach:
1. In `apps/worker/src/simulate/book.ts`, introduce a helper like:
   - `simulateBookFillsFromBook(book, side, targetShareMicros, maxPriceMicros?, minPriceMicros?)`
2. Keep the existing `simulateBookFills(tokenId, ...)` as a wrapper that:
   - calls `fetchOrderBook(tokenId)`
   - calls the new `...FromBook` helper

This keeps call sites clean and avoids duplicate logic.

### Step 3 — Fix executor order of operations (the actual bug fix)
In `apps/worker/src/simulate/executor.ts`:
1. Fetch the order book first (`fetchOrderBook(effectiveTokenId)`)
2. Compute best bid/ask/mid/spread from the book (or reuse a helper)
3. Compute price bounds using the computed `midPriceMicros`
4. Simulate fills using those bounds against the same book (`simulateBookFillsFromBook`)
5. Run guardrails based on the simulation result

Expected result after the fix:
- For BUY attempts where the book is near the leader’s price, you should see:
  - `maxPriceMicros` close to `leaderVWAP + 0.01` (or `mid + 0.015`, whichever is smaller)
  - Non-zero `availableNotionalMicros`
  - Often non-zero `filledShareMicros`
- You should start seeing **some** `CopyDecision.EXECUTE` decisions in normal liquid markets.

### Step 4 — Add automated tests (prevents regressions)
There is already Vitest in `apps/worker`.

Add at least:
1. A small unit test around BUY bound logic:
   - Given `theirRef=600000` and `mid=600000`, max BUY price should be `min(610000, 615000)=610000` (with current defaults).
2. An executor-level test that mocks `fetchOrderBook` and proves:
   - With a realistic book (asks at/below bounds), result is `EXECUTE` (no `NO_LIQUIDITY_WITHIN_BOUNDS`).

### Step 5 — Run and verify locally (smoke tests)
Use the repo’s runbook:
- `docker compose -f docker/docker-compose.dev.yml up -d`
- `pnpm dev`

Validation checklist:
- UI shows new copy attempts being created quickly after leader trades.
- At least one attempt shows `Decision=EXECUTE` with:
  - `filledNotionalMicros > 0`
  - one or more `ExecutableFill` rows
  - a `LedgerEntry` row with `refId = copy:<copyAttemptId>`
- Portfolio snapshots reflect the open position (exposure > 0).

### Step 6 — If still skipping a lot: loosen guardrails temporarily (prove pipeline)
Once the bug is fixed, if you still get frequent skips due to `SPREAD_TOO_WIDE` or `INSUFFICIENT_DEPTH`, temporarily relax guardrails to prove the system end-to-end, then tighten.

Guardrails live in DB (`GuardrailConfig`) and override defaults from:
- `apps/worker/src/simulate/config.ts`

Suggested temporary values (for “make it work first”):
- `maxSpreadMicros`: try `50_000` ($0.05) or `100_000` ($0.10)
- `minDepthMultiplierBps`: try `10_000` (1.0x)
- keep price-protection (`maxWorseningVsTheirFillMicros`, `maxOverMidMicros`) conservative unless you explicitly want to chase

Definition of success for this step:
- Most liquid markets should EXECUTE sometimes.
- SKIPs should be explainable and correlate with real spread/depth conditions.

### Step 7 — Validate the “position lifecycle” (buy → hold → sell → settle)
What is already working:
- On EXECUTE, a `LedgerEntry` is written for `PortfolioScope.EXEC_GLOBAL` in `apps/worker/src/simulate/executor.ts`.
- Positions and equity show up via `apps/worker/src/snapshot/portfolio.ts`.
- Leader SELLs should create SELL groups; the executor has `isReducingExposure(...)` to avoid blocking closes with risk caps.

What to confirm / possibly implement:
- **Settlement on resolution** for the executable portfolio depends on writing `SETTLEMENT`/`REDEEM`-like ledger entries for the bot’s wallet.
  - Shadow portfolios already mirror leader `REDEEM` activity in `apps/worker/src/portfolio/shadow.ts`.
  - If you want the executable portfolio to realize resolved P/L automatically, you’ll need a similar ingestion/writer path for the bot’s own settlement/redemption events.

## Definition of Done
You can consider this “fixed” when all are true:
- BUY attempts no longer compute `maxPriceMicros ≈ 15000` unless the real mid is near 0.
- At least one followed-user BUY triggers a `CopyDecision.EXECUTE` under normal market conditions.
- Executed attempts create `ExecutableFill` + `LedgerEntry` and show up in portfolio snapshots.
- SKIPs show reasons that match reality (spread/depth/price protection), not a systematic artifact.

