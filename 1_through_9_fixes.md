# Steps 1–9 Fixes (to align with `live_trading_plan.md`)

This file lists the **required fixes/adjustments** to bring the current “Steps 1–9” implementation fully in line with the spec in:
- `live_trading_plan.md`
- `live_trading_steps.md`

Scope: **only** fixes for steps **1 through 9** (DB/config/shared decision infra/live plumbing). Step 10 (Live Executor) is intentionally out of scope, except where earlier work must be corrected to unblock it safely.

---

## 0) Non‑negotiable invariants (must hold after fixes)

1. **Paper is unchanged** when live is OFF (and also when live code exists but live toggles are OFF).
2. **Live state is fail‑closed**: if we cannot obtain fresh authoritative cash+positions, we treat live as unhealthy and do **not** place live orders.
3. **No unit mismatches** (micros vs decimals; shares vs USDC) across order placement, fills, ledger, and account state.
4. **External wallet activity is captured** (fills/trades not caused by the bot are persisted and reflected in Real Portfolio state).

---

## 1) Step 2 — DB schema/migrations: fix remaining breakages

### 1.1 Fix GlobalPortfolioState lookups after migration

**Problem:** `GlobalPortfolioState` is now keyed by `(tradingMode, portfolioScope)` and `id` is a UUID, but one API route still upserts by `id: "EXEC_GLOBAL"`.

**Required change**
- Update `apps/web/src/app/api/portfolio/global/deposit/route.ts` to upsert using:
  - `where: { tradingMode_portfolioScope: { tradingMode: PAPER, portfolioScope: EXEC_GLOBAL } }`
  - `create: { tradingMode: PAPER, portfolioScope: EXEC_GLOBAL, ... }`
- Ensure the created `LedgerEntry` for deposits is also `tradingMode=PAPER` (it defaults to PAPER today; keep it explicit or leave as default, but be consistent).

### 1.2 Audit for any remaining `"EXEC_GLOBAL"` id usage

**Required change**
- Search for any more usages of `globalPortfolioState` with `where: { id: "EXEC_GLOBAL" }` (or any fixed id assumptions) and convert to the composite key.

---

## 2) Step 3 — Shared config/types: wire the global toggles

### 2.1 Wire system toggles into worker runtime

**Problem:** `paperTradingEnabled`, `liveTradingEnabled`, and `liveTradingReadOnlyEnabled` exist but are not enforced. The worker starts live WS + reconciliation whenever a private key is present.

**Required change**
- Gate live modules in `apps/worker/src/index.ts`:
  - Start **live reconciliation** only if:
    - `POLYMARKET_LIVE_PRIVATE_KEY` is present **and**
    - (`liveTradingEnabled === true` **or** `liveTradingReadOnlyEnabled === true`)
  - Start **user channel WS** only if:
    - same gating as above (read‑only should still ingest external fills), or at minimum when `liveTradingEnabled` is true.
- Gate paper trading:
  - If `paperTradingEnabled === false`, do not execute paper copy attempts (either skip enqueueing in the group processor or early‑return in the paper executor/worker).

### 2.2 Ensure paper endpoints default to PAPER mode

**Problem:** paper UI APIs do not filter by `tradingMode`, so LIVE attempts will leak into paper pages once live attempts are stored.

**Required change**
- Update `apps/web/src/app/api/copy-attempts/route.ts` to filter `tradingMode: PAPER` by default (or accept a `mode=` query param and default to PAPER).

---

## 3) Step 4 — Shared Decision Engine: restore paper parity

### 3.1 Paper portfolio/risk state must not include LIVE ledger rows

**Problem:** paper `getPortfolioState()` currently reads `ledgerEntry` without filtering `tradingMode`, so LIVE fills can change paper exposure caps and decisions.

**Required change**
- In `apps/worker/src/simulate/executor.ts`:
  - Add `tradingMode: PAPER` to all `ledgerEntry` queries used for paper risk/exposure computation (`groupBy`, per-user exposure, etc.).

### 3.2 Restore circuit breaker behavior (avoid silent behavior change)

**Problem:** `apps/worker/src/trading/decisionEngine.ts` explicitly skips circuit breaker checks, but paper executor does not re-apply them. This risks paper behavior drift.

**Required change**
- Either:
  - Move the circuit breaker + “reducing exposure” logic into the decision engine (preferred), **or**
  - Ensure paper executor performs the same circuit breaker checks after calling `makeDecision()` and before persisting an EXECUTE.
- Acceptance: paper decisions should match the pre-refactor behavior for the same inputs.

---

## 4) Step 5 — TokenTradingParamsCache: fail‑closed on missing/invalid params

### 4.1 Remove “default tick/min” behavior for live placement safety

**Problem:** `apps/worker/src/live/tradingParams.ts` defaults `minimum_tick_size` to `$0.01` and `minimum_order_size` to `1 share` when the API field is missing. The spec says fail‑closed if params are unknown.

**Required change**
- If `minimum_tick_size` or `minimum_order_size` is missing/invalid, return `available: false` with a clear reason (e.g., `MARKET_INFO_INVALID`).
- Ensure live execution (Step 10) SKIPs with `ReasonCodes.LIVE_INVALID_TICK_OR_STEP` (or a more specific code) when params are unavailable.

---

## 5) Step 6 — LiveAccountStateCache: fix fill accounting semantics

### 5.1 Ensure fill notional is always passed as a positive amount

**Problem:** `apps/worker/src/live/userChannelWs.ts` passes a signed cash delta into `applyFill`, but `applyFill` expects a **positive** notional amount and applies the sign itself. This causes BUY fills to increase cash.

**Required change**
- In `apps/worker/src/live/userChannelWs.ts`, call `applyFill(tokenId, side, shareMicros, notionalMicros, reservationId?)` with `notionalMicros` always positive.
- If fees should affect cash availability immediately, either:
  - extend `applyFill` to accept `feeMicros` and subtract/add it consistently, or
  - handle fee deltas outside of `applyFill` but in a single consistent place.

---

## 6) Step 7 — CLOB client wrapper: fix order sizing units (critical)

### 6.1 Fix BUY order sizing for `createAndPostMarketOrder`

**Problem:** In `@polymarket/clob-client`, `UserMarketOrder.amount` means:
- BUY: **USDC amount**
- SELL: **share amount**

Current code passes share amount for BUY as well.

**Required change**
- In `apps/worker/src/live/clobClient.ts`:
  - For BUY: compute `buyAmountUsdc = (priceMicros * sizeShareMicros) / 1_000_000` (floor) and pass that (converted to decimal) as `amount`.
  - For SELL: pass `sizeShareMicros` (converted to decimal shares) as `amount`.
- Ensure conversions do not overflow `number` for larger sizes (prefer decimal strings if needed).

### 6.2 Normalize error codes to the reason-code taxonomy you actually use

**Problem:** current normalization maps some exchange errors to codes that don’t align cleanly with `ReasonCodes` (and mixes “rejected” vs “pre-check failure” concepts).

**Required change**
- Standardize: network/timeouts => retryable error classification; exchange validation => `LIVE_ORDER_REJECTED_*` codes.
- Ensure any error code you emit is present in `packages/shared/src/reasonCodes.ts` (or is normalized to an existing one).

---

## 7) Step 8 — User Channel WS: external fills + robust persistence

### 7.1 Persist external fills (do not drop them)

**Problem:** when a trade message doesn’t match any `LiveOrder`, the code buffers it as an orphan and eventually drops it (only logs). Spec requires external fills to be persisted.

**Required change**
- Upsert `LiveFill` immediately on every trade event:
  - Default `origin=EXTERNAL`, `liveOrderId=null`
  - If a matching `LiveOrder` is found later, update the row to `origin=APP` + set `liveOrderId`.
- Keep the orphan buffer only as an optimization for retro-linking, not as the only persistence path.

### 7.2 Update LiveOrder aggregates and status transitions

**Required change**
- On order updates and/or confirmed fills:
  - update `LiveOrder.filledShareMicros`, `filledNotionalMicros`, `avgFillPriceMicros`
  - map REJECTED/CANCELED/FILLED statuses correctly (include `REJECTED` mapping)

### 7.3 MarketId enrichment for ledger entries (recommended for parity)

**Required change**
- When writing live `LedgerEntry`, fill `marketId` using `TokenMetadataCache` if available (matches paper’s ledger enrichment expectations and makes UI queries cheaper).

---

## 8) Step 9 — Reconciliation: must be fail‑closed + safer SUBMISSION_UNKNOWN resolution

### 8.1 Do not “succeed” reconciliation with empty positions

**Problem:** `apps/worker/src/live/reconciliation/stateReconciler.ts` falls back to `positions=[]` when both CLOB and Data API fail, then writes that to DB (zeroing positions).

**Required change**
- If positions cannot be fetched authoritatively, return error and **do not** write to DB or update in-memory state.
- Mark reconciliation unhealthy so live execution is gated.

### 8.2 Improve SUBMISSION_UNKNOWN resolution beyond open-orders only

**Problem:** `apps/worker/src/live/reconciliation/orderReconciler.ts` matches SUBMISSION_UNKNOWN using only `listOpenOrders()`. Orders that fully fill quickly will not be found there.

**Required change**
- Add bounded “recent trades” scanning and/or “recent orders” lookup as a second matching path for SUBMISSION_UNKNOWN.
- Keep strict matching basis (tokenId, side, rounded price, rounded size, time window) and leverage the fact that submissions are serialized (concurrency=1).

---

## 9) Quick verification checklist (after applying fixes)

- Paper-only run (no live key): paper behavior unchanged.
- Live key present but toggles OFF: no live WS/reconciliation started; paper still unchanged.
- Live read-only ON: reconciliation + user-channel ingest run; external fills appear as `LiveFill.origin=EXTERNAL`.
- Deposit endpoint works again and updates `GlobalPortfolioState(PAPER, EXEC_GLOBAL)` correctly.
- A synthetic live fill event updates cash/shares correctly (BUY reduces cash; SELL increases cash).
- No paper queries (`executor.ts` risk state) read LIVE ledger rows.

