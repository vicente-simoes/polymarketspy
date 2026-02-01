# Live Trading Mode — Implementation Steps (MVP)

This is the **step-by-step implementation guide** for adding a fully working **Live Trading Mode** to PolymarketSpy, based on:
- `live_trading_plan.md` (source-of-truth spec)
- `live_choices.md` (final MVP decisions that unblock implementation)

The goal is that **if you implement every step below**, you will have:
- Paper trading unchanged
- Live trading that places real CLOB orders safely
- Live Orders/Fills UI + Real Portfolio UI driven by **exchange-authoritative** state
- Idempotent, retry-safe execution with reconciliation and clear ops controls

---

## 0) Ground Rules (Read This First)

### 0.1 Definitions (must stay consistent)
- **PAPER**: current simulated copy execution path (existing behavior).
- **LIVE**: real authenticated CLOB execution path (new).
- **TradingMode**: `PAPER | LIVE` (new DB dimension; used everywhere).
- **PortfolioScope**: remains a DB dimension, but current code uses `EXEC_GLOBAL` only for execution + portfolio read models; `SHADOW_USER` is deprecated/unused and `EXEC_USER` is legacy. Live trading must not rely on shadow portfolios (attribution is via `followedUserId`).
- **SizingMode**: FIXED_RATE only for MVP (budgeted dynamic sizing is currently disabled in code and would require a redesign to re-enable).

### 0.2 MVP live choices (do not deviate)
- **Do not rely on `clientOrderId` lookup** on the exchange. Dedupe is our DB `idempotencyKey`. Reconciliation is via `clobOrderId` + open-orders/trades scanning.
- **Tick/min constraints** come from exchange metadata (`minimum_tick_size`, `minimum_order_size`) and are cached per token.
- **Size step** defaults to **1 micro-share** unless the exchange proves otherwise via rejection.
- **Oversubscription prevention**: serialize live placement (**concurrency=1 per wallet**) and use a lightweight reservation layer.
- **Authoritative live state**: use TS client methods first; fall back to Data API for positions if needed. If state is not fresh/available, **do not place live orders**.

---

## 1) Prep & Safety

### 1.1 Baseline sanity (before touching live)
**Goal:** know the repo is healthy before adding complexity.
- Run the worker + web in dev and confirm paper trading flows still work.
- Record current routes and behavior (Copy Attempts page, Portfolio page).
- Confirm DB migrations run cleanly in your environment.

**Done when:**
- You can run `pnpm dev` and open the existing UI.
- No unexpected Prisma/migration issues.

### 1.2 Define the live execution wallet (operational decision)
**Goal:** avoid mixing “dev wallet” and “prod wallet” behavior.
- Decide on the single live execution wallet (MVP is one wallet).
- Ensure you have a safe funding workflow (do not put secrets in git or logs).
- Decide whether you want live **read-only** portfolio monitoring while `liveTrading=OFF` (optional, but recommended).

**Done when:**
- You have a clear plan for secrets injection and wallet funding for dev/prod.

---

## 2) Database Schema & Migrations

### 2.1 Add `TradingMode` and make existing rows `PAPER`
**Goal:** make “paper vs live” a first-class dimension everywhere.

**Changes (Prisma):**
- Add `enum TradingMode { PAPER LIVE }`.
- Add `tradingMode TradingMode` to:
  - `CopyAttempt`
  - `LedgerEntry`
  - `GlobalPortfolioState`
  - `CurrentPosition`
  - `CurrentPositionByLeader`
  - `EquityPoint`
  - `GuardrailConfig`
  - `CopySizingConfig`
- Update uniqueness:
  - `CopyAttempt`: uniqueness should include `tradingMode`.
  - `LedgerEntry`: uniqueness should include `tradingMode`.
  - `GlobalPortfolioState`: uniqueness should include `tradingMode` (paper vs live cash/baseline must not collide).
  - `CurrentPosition`: uniqueness should include `tradingMode`.
  - `CurrentPositionByLeader`: uniqueness should include `tradingMode`.
  - `EquityPoint`: uniqueness should include `tradingMode`.

**Note on legacy tables:**
- `PortfolioSnapshot` exists in the schema but current UI reads from `GlobalPortfolioState`/`CurrentPosition`/`EquityPoint`. We should not expand `PortfolioSnapshot` for live; either keep it as legacy or remove it in a cleanup migration.

**Backfill:**
- Default all existing rows to `tradingMode=PAPER`.

**Done when:**
- Migration applies cleanly.
- Existing UI/queries still return the same paper results (now filtering `tradingMode=PAPER` where needed, especially on the portfolio read models + equity curve).

### 2.2 Create live persistence tables
**Goal:** store the complete live execution trail.

**Add tables (minimum):**
- `LiveOrder`
  - `id`, `copyAttemptId`, `followedUserId?`, `idempotencyKey` (unique), `clientOrderId?` (optional unique), `clobOrderId?` (nullable unique)
  - `tokenId`, `side`, `orderType`, `limitPriceMicros`, `sizeShareMicros`
  - decision snapshot fields: `bestBidMicrosAtDecision`, `bestAskMicrosAtDecision`, `bookSource`, `bookAgeMs`
  - fill tracking aggregates: `filledShareMicros`, `filledNotionalMicros`, `avgFillPriceMicros`
  - `status`, `createdAt`, `submittedAt?`, `lastUpdateAt?`, `finalizedAt?`
  - error fields: `lastErrorCode?`, `lastErrorMessage?`
- `LiveFill`
  - `id`, `liveOrderId?`, `origin` (`APP|EXTERNAL`)
  - `tradeId` (unique), `clobOrderId`, `tokenId`, `side`
  - `matchedAt`, `priceMicros`, `shareMicros`, `notionalMicros`, `feeMicros?`, `status`

**Indexes (minimum):**
- `LiveOrder(status)`, `LiveOrder(createdAt)`, `LiveOrder(tokenId, createdAt)`
- `LiveFill(matchedAt)`, `LiveFill(clobOrderId)`

**Done when:**
- You can create a `CopyAttempt(tradingMode=LIVE)` and attach a `LiveOrder`.
- You can upsert `LiveFill` by `tradeId`.

### 2.3 Create “real portfolio” caches/snapshots
**Goal:** power Real Portfolio UI from authoritative exchange state.

**Approach (match current paper architecture):**
- The Real Portfolio UI should read from the same portfolio read models as paper, but with `tradingMode=LIVE`:
  - `GlobalPortfolioState(tradingMode=LIVE, portfolioScope=EXEC_GLOBAL)` for cash + baseline/contributed capital
  - `CurrentPosition(tradingMode=LIVE, assetId)` for net positions
  - `EquityPoint(tradingMode=LIVE, granularity, bucketTime)` for the PnL curve
- `CurrentPrice` stays shared across modes (it is just market marks).

**Add tables (live-only, minimum):**
- `TokenTradingParamsCache`
  - `tokenId` (unique), `tickSizeMicros`, `minOrderSizeShareMicros`, `sizeStepShareMicros`, `updatedAt`

**Optional but recommended (audit/debug):**
- `RealPositionSnapshot` (raw exchange positions)
  - `id`, `bucketTime` (or `asOf`), `tokenId`, `shareMicros`, plus optional metadata fields you want for debugging (source, fetchedAt).

**Baseline storage (choose one, be explicit):**
- Store live baseline in `SystemCheckpoint` keys (recommended for MVP):
  - `live:baselineTime`
  - `live:baselineEquityMicros`
  - `live:baselinePositions` (JSON)

**Done when:**
- A reconciliation process can write:
  - `GlobalPortfolioState(tradingMode=LIVE, portfolioScope=EXEC_GLOBAL)`
  - `CurrentPosition(tradingMode=LIVE, ...)` rows
  - `EquityPoint(tradingMode=LIVE, ...)` rows (via the equity-point loop)
  - `TokenTradingParamsCache` rows

---

## 3) Shared Types & Config (packages/shared)

### 3.1 Add live reason codes
**Goal:** Live SKIPs/REJECTs are visible and filterable.

**Add to `packages/shared/src/reasonCodes.ts`:**
- `LIVE_NO_FRESH_BOOK`
- `LIVE_NOT_MARKETABLE_WITHIN_BOUNDS`
- `LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING`
- `LIVE_BELOW_MIN_ORDER_SIZE`
- `LIVE_INVALID_TICK_OR_STEP`
- `LIVE_INSUFFICIENT_CASH_TO_BUY`
- `LIVE_ORDER_REJECTED_<ERROR_CODE>` pattern (implementation detail: normalize to specific known codes)

**Done when:**
- Worker can persist `CopyAttempt(reasonCodes=...)` for live skips with these codes.

### 3.2 Extend system config with paper/live switches
**Goal:** control live placement independently of paper simulation.

**Add to `SystemConfigSchema` + defaults:**
- `paperTradingEnabled: boolean` (default `true`)
- `liveTradingEnabled: boolean` (default `false`)
- Optional but recommended:
  - `liveTradingReadOnlyEnabled: boolean` (default `false`) to allow Real Portfolio monitoring while placement is OFF.

**Done when:**
- Worker can read these toggles and gate:
  - paper simulation execution
  - live order placement
  - live read-only reconciliation (if you implement it)

### 3.3 Make guardrails/sizing mode-aware
**Goal:** allow separate PAPER vs LIVE configs without collisions.

**DB wiring:**
- `GuardrailConfig` and `CopySizingConfig` already exist; after adding `tradingMode`, update all load paths to include it.

**Live additions (store in LIVE guardrails configJson or a dedicated live config schema):**
- `liveSlippageBpsBuy`
- `liveSlippageBpsSell`
- `liveBookFreshnessMs`
- `liveBookWaitMs`
- `liveOrderType` (MVP default `FAK`)

**Small trade buffering:**
- Today it’s stored under `SystemCheckpoint key=config:smallTradeBuffering`.
- Make it mode-aware:
  - `config:smallTradeBuffering:PAPER`
  - `config:smallTradeBuffering:LIVE`

**Done when:**
- `getUserConfig(mode=PAPER)` returns exactly today’s behavior.
- `getUserConfig(mode=LIVE)` returns live-specific defaults + overrides.

---

## 4) Worker: Refactor to a Shared Decision Engine

### 4.1 Extract “decision” from “execution”
**Goal:** one strategy/decision path; two executors.

**Create a new module (suggested):**
- `apps/worker/src/trading/decisionEngine.ts`

**Inputs:**
- `EventGroup` (trade/activity group)
- effective config (guardrails, sizing, buffering) for the mode
- portfolio/risk state for the mode
- best book snapshot (and its freshness metadata)

**Outputs (`CopyIntent`):**
- `idempotencyKey`
- `tokenId`, `side`, `groupKey`, `followedUserId`, `sourceType`
- `targetNotionalMicros`, `targetShareMicros`
- bounds: `maxBuyPriceMicros` / `minSellPriceMicros`
- decision: `EXECUTE|SKIP` and `reasonCodes`
- decision-time observability fields (best bid/ask, book age/source, leader vwap/mid)

**Done when:**
- Paper executor and Live executor can both call the same decision engine and receive consistent intent output.

---

## 5) Worker: Token Trading Params Cache (tick/min/step)

### 5.1 Implement `TokenTradingParamsCache` loader
**Goal:** never submit orders without knowing tick/min constraints.

**Create a new module (suggested):**
- `apps/worker/src/live/tradingParams.ts`

**Algorithm (MVP):**
1. Given `tokenId`, look up `TokenMetadataCache.conditionId`.
2. If missing: attempt to derive via existing enrichment; persist it back to `TokenMetadataCache`.
3. If still missing: fail closed → return “unavailable” and SKIP live placement.
4. Fetch MarketInfo for the `conditionId`.
5. Parse:
   - `minimum_tick_size` → `tickSizeMicros`
   - `minimum_order_size` → `minOrderSizeShareMicros`
6. Set `sizeStepShareMicros = 1` unless a real rejection proves otherwise.
7. Write `TokenTradingParamsCache` for each token in that condition.

**Done when:**
- LiveExecutor can call `getTradingParams(tokenId)` and always get tick/min (or a clear “unavailable” result).

---

## 6) Worker: Live Account State + Reservations (Concurrency=1)

### 6.1 Implement `LiveAccountStateCache`
**Goal:** deterministic pre-trade checks and safe reservations.

**Create a module (suggested):**
- `apps/worker/src/live/accountState.ts`

**State (minimum):**
- `cashAvailableMicros`, `reservedCashMicros`
- `sharesAvailableMicrosByTokenId`, `reservedSharesMicrosByTokenId`
- `lastReconciledAt`

**Reservation rules (MVP):**
- Before submitting an order:
  - BUY: reserve worst-case cash = `limitPriceMicros * sizeShareMicros / 1_000_000` (+ small fee buffer if needed)
  - SELL: reserve `sizeShareMicros`
- Adjust reservations on:
  - user-channel fill events
  - cancel/finalization events
  - periodic reconciliation (authoritative reset/correction)

**Submission serialization:**
- Enforce a per-wallet mutex/queue so only one live placement happens at a time.

**Done when:**
- It is impossible for two concurrent live submissions to oversubscribe cash/shares.

---

## 7) Worker: Authenticated CLOB Client Wrapper

### 7.1 Add the official Polymarket TS client
**Goal:** use the supported path for signing/auth and account state.

**Steps:**
- Add the dependency in `apps/worker/package.json`:
  - From repo root: `pnpm --filter @copybot/worker add @polymarket/clob-client`
- Create a wrapper module:
  - `apps/worker/src/live/clobClient.ts`

**Wrapper must expose (minimum):**
- `createOrderFAK(...)` → returns `clobOrderId` (and any immediately-known status)
- `getOrder(clobOrderId)` (for reconciliation)
- `listOpenOrders()` and/or the minimal endpoints needed to reconcile `SUBMISSION_UNKNOWN`
- Authenticated account state:
  - cash/collateral balance
  - positions (or clearly throw “unsupported” so we use fallback)

**Required env vars (do not hardcode; do not log):**
- `POLYMARKET_LIVE_PRIVATE_KEY` (hex string, 0x-prefixed): the live execution wallet private key.
- Keep using `POLYMARKET_CLOB_BASE_URL` (already in `.env.example`) as the CLOB host (default `https://clob.polymarket.com`).
- Use Polygon `CHAIN_ID=137` (hardcode as a constant or add `POLYMARKET_CHAIN_ID=137` if you prefer it configurable).
- Add these to `.env.example` and validate via `apps/worker/src/config/env.ts`.

**Implementation notes (MVP, matches Polymarket TS client workflow):**
- Construct a signer: `new Wallet(env.POLYMARKET_LIVE_PRIVATE_KEY)`.
- Initialize a temporary client and derive API creds once on startup:
  - `const temp = new ClobClient(env.POLYMARKET_CLOB_BASE_URL, 137, signer);`
  - `const creds = await temp.createOrDeriveApiKey();`
  - `const client = new ClobClient(env.POLYMARKET_CLOB_BASE_URL, 137, signer, creds);`
- For order placement, convert your internal micros to the units required by `createAndPostOrder` (per the TS client docs) and keep conversion logic centralized/tested.

**Done when:**
- You can successfully place a tiny test order in a controlled environment and receive a `clobOrderId`.

---

## 8) Worker: User Channel WebSocket (Orders + Fills)

### 8.1 Implement User Channel listener
**Goal:** track orders/fills in near-real-time.

**Create a module (suggested):**
- `apps/worker/src/live/userChannelWs.ts`

**Responsibilities:**
- Connect/auth to the user channel.
- Parse order updates and trade/fill updates.
- For each update:
  - upsert `LiveOrder` status transitions
  - upsert `LiveFill` by `tradeId`
  - write `LedgerEntry(tradingMode=LIVE, refId=tradeId, entryType=TRADE_FILL)`
  - update `LiveAccountStateCache` (cash/shares + reservations)

**Done when:**
- A placed live order appears in DB as `LiveOrder`, and fills appear as `LiveFill` rows without duplication.

---

## 9) Worker: Periodic Reconciliation (Safety Net)

### 9.1 Reconcile open orders
**Goal:** heal missed WS events and resolve `SUBMISSION_UNKNOWN` safely.

**Loop (every 30–60s):**
- For each non-final `LiveOrder`:
  - If `clobOrderId` exists: call `getOrder(clobOrderId)` and update status/filled totals.
  - If `SUBMISSION_UNKNOWN` and `clobOrderId` missing:
    - Because we serialize submissions, scan open orders + recent trades and match on:
      - `(tokenId, side, rounded limit price, rounded size, time window)`
    - If matched: attach `clobOrderId` and continue.
    - If not matched within bounded time (e.g., 5–10 minutes): mark `FAILED`, alert, and pause further submissions until manual clearance.

**Done when:**
- The system never “double-submits” after a timeout.

### 9.2 Reconcile positions + cash (authoritative)
**Goal:** Real Portfolio is always exchange-truth.

**Loop (every 60s, bucketed to minute):**
- Fetch authoritative cash + positions:
  - TS client first
  - Data API fallback for positions (map to token IDs as needed)
- Write:
  - `GlobalPortfolioState(tradingMode=LIVE, portfolioScope=EXEC_GLOBAL)` (cash + contributed capital/baseline)
  - `CurrentPosition(tradingMode=LIVE, ...)` (net positions, derived from exchange truth)
  - (optional) `RealPositionSnapshot` (latest/bucketed raw exchange positions for audit/debug)
- Update `LiveAccountStateCache` from the authoritative snapshot (correct drift).
- Compute and persist ledger-vs-exchange diffs for debugging and surface them in the UI.
- Health gating:
  - if this fails → set live unhealthy, do not place orders.

**Done when:**
- Real Portfolio page can be driven entirely from these read models (and is clearly labeled as exchange-authoritative).

---

## 10) Worker: Live Executor (Placing Orders)

### 10.1 Implement the live executor
**Goal:** turn CopyIntents into live orders safely.

**Create a module (suggested):**
- `apps/worker/src/live/executor.ts`

**Per event-group execution (LIVE):**
1. Check global + per-user enablement:
   - global `liveTradingEnabled`
   - per-user `liveOverride`
2. Fetch a fresh book:
   - require `bookAgeMs <= liveBookFreshnessMs`
   - otherwise wait `liveBookWaitMs` then SKIP (`LIVE_NO_FRESH_BOOK`)
3. Load trading params from cache:
   - tick/min; fail closed if missing
4. Run decision engine → get `CopyIntent` and decision.
5. Always persist a `CopyAttempt(tradingMode=LIVE)`:
   - if SKIP: persist reason codes and stop.
6. If EXECUTE:
   - acquire per-wallet mutex
   - compute rounded order params:
     - BUY: floor tick; SELL: ceil tick
     - floor size to step
     - enforce post-rounding marketability
   - apply cash/position checks with shrink-to-affordable / shrink-to-available
   - reserve cash/shares
   - create-or-get `LiveOrder` by `idempotencyKey`:
     - if exists: do not resubmit; release any new reservation and stop
   - submit order via TS client (FAK)
   - persist `clobOrderId` and move status out of `SUBMITTING`
   - on timeout: set `SUBMISSION_UNKNOWN`, keep submissions paused until resolved

**Done when:**
- Live orders can be placed end-to-end and appear in UI with fills and correct status transitions.

---

## 11) Worker: Queueing & Integration With Existing Pipeline

### 11.1 Add a live copy-attempt queue (recommended)
**Goal:** keep paper and live execution decoupled and observable.

**Steps:**
- Add a new BullMQ queue name, e.g. `LIVE_COPY_ATTEMPT_GLOBAL`.
- In the group aggregation pipeline, enqueue:
  - paper job (existing queue)
  - live job (new queue)
- Configure live worker concurrency = 1 (per wallet).

**Done when:**
- A single event group generates both a PAPER and LIVE attempt without one blocking the other.

---

## 12) Web App: UI + API Changes

### 12.1 Route and navigation updates (paper renames)
**Goal:** keep current behavior but relabel as paper.
- Rename Copy Attempts → Paper Trades.
- Rename Portfolio → Paper Portfolio.
- Add redirects from old routes.
- Keep (and reuse) the decision-time book provenance indicators: `CopyAttempt.bookSource` and `CopyAttempt.usedRestFallback` should be visible on both Paper Trades and Live Trades rows.

**Done when:**
- No broken links; existing pages still work.

### 12.2 Add Live Trades page
**Goal:** operational live dashboard.

**Must include:**
- Status panel:
  - global OFF/ON
  - per-user overrides summary
  - auth status
  - WS connected? last event time
  - last reconcile time
  - open orders count; `SUBMISSION_UNKNOWN` count
  - last error
- Tables:
  - Live Orders
  - Live Fills (APP vs EXTERNAL)
  - Skipped/Rejected (reason codes)
  - Include a small `WS`/`REST` badge and a REST-fallback indicator when the decision used a REST book due to WS invalidity/staleness.

**Done when:**
- A live order placed by the worker is visible here with fills and status.

### 12.3 Add Real Portfolio page
**Goal:** display exchange-authoritative portfolio with baseline semantics.

**Must include:**
- “PnL since baseline <time>” labeling
- last reconciliation time
- clear indicator if ledger-vs-exchange diffs exist
- positions table + mark pricing

**Done when:**
- Real Portfolio displays correct positions per reconciliation snapshot.

### 12.4 Config UI (Paper vs Live)
**Goal:** edit PAPER and LIVE configs independently.

**Must include:**
- `/config` mode selector: Paper | Live
- Write `GuardrailConfig` / `CopySizingConfig` rows with `tradingMode`.
- Mode-aware small trade buffering config keys.

**Done when:**
- Changing LIVE slippage or min/max notional affects only live execution.

### 12.5 Users page: per-user live override
**Goal:** allow per-followed-user enable/disable for live.

**Done when:**
- Overrides actually gate live placements in the worker.

---

## 13) Testing & Verification (Do Not Skip)

### 13.1 Unit tests (worker)
**Must cover:**
- idempotencyKey determinism
- tick rounding (floor/ceil) and post-rounding marketability check
- shrink-to-affordable/shrink-to-available logic
- reservation accounting correctness
- `SUBMISSION_UNKNOWN` pause behavior

### 13.2 Integration smoke test (dev)
**Checklist:**
1. `liveTradingEnabled=false`: no live orders placed.
2. Toggle `liveTradingEnabled=true` with tiny limits:
   - place one small order
   - confirm `LiveOrder` row + `clobOrderId`
   - confirm fill appears via user channel or reconciliation
3. Force a timeout (simulate by blocking network) and confirm:
   - `SUBMISSION_UNKNOWN` is set
   - system pauses further submissions
   - reconciliation resolves or escalates to manual clearance

### 13.3 UI acceptance
**Checklist:**
- Paper pages unchanged and still populate.
- Live Trades shows orders/fills/skips with reason codes.
- Real Portfolio shows authoritative positions and baseline labeling.

---

## 14) Definition of “Fully Ready / Fully Working”

You can consider the live trading implementation “done” when all are true:
- Paper trading behavior is unchanged when `liveTradingEnabled=false`.
- Live placements are **idempotent** and never double-submit after timeouts.
- Live uses tick/min constraints from exchange metadata and fails closed if missing.
- Live has concurrency=1 + reservations and cannot oversubscribe cash/shares.
- User channel WS + reconciliation keep orders/fills consistent (no dup fills).
- Real Portfolio is driven by authoritative reconciliation snapshots and labels baseline semantics.
- Kill switches and per-user overrides work immediately and are visible in UI.
