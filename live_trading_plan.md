# Live Trading Mode — Implementation Spec (Parallel to Paper)

This document is the **source-of-truth spec** for adding **Live Trading Mode** to PolymarketSpy, following `live_trading_info.md` and the additional UX requirements from this request. This is **not** a step-by-step build guide; it defines the **macro decisions**, **system behavior**, and **interfaces/data** we will later implement.

---

## 0) Goals / Non-goals

### Goals
- Add a **fully parallel** live execution path that can be **enabled/disabled**:
  - **Global** live state (OFF / ON).
  - **Per-followed-user** live override (INHERIT / FORCE_ON / FORCE_OFF).
- Keep **paper trading behavior unchanged** when live is OFF.
- Keep the **strategy/decision logic shared** between paper + live wherever feasible; swap only the **execution adapter**.
- Add new UI surfaces:
  - Rename current **Copy Attempts** page → **Paper Trades** (same functionality).
  - Rename current **Portfolio** page → **Paper Portfolio** (same functionality).
  - Add **Live Trades** page (paper-trades-like, but for live orders/fills/skips).
- Add **Real Portfolio** page (live portfolio view).
- Provide **separate settings** for paper vs live when it makes sense (guardrails, sizing, buffering, system toggles).
- Meet operational safety requirements (idempotency, kill switches, secrets hygiene).

### Non-goals (for MVP)
- Perfect % return matching vs the leader (tracking error is expected).
- Complex order tactics (icebergs, post-only market making, multi-venue routing).
- Multi-account execution (MVP uses a single live execution wallet and a single global live portfolio).

---

## 1) Core product truth: “similar % return” and tracking error

We will message the live mode capability as:
> “We aim to track leader exposure changes closely; % returns are often similar but not guaranteed.”

Tracking error is expected due to:
- missed trades (downtime / reconnect gaps)
- latency / slippage differences
- partial fills (especially with FAK)
- Polymarket constraints (min size, tick size)
- our guardrails and bankroll caps
- inventory constraints (can’t sell what we don’t hold; may lack USDC to buy)
- differing settlement timing vs leader lifecycle

---

## 2) Two execution modes, always parallel

### Mode names
- **Paper**: current simulated copy execution (today’s behavior).
- **Live**: authenticated Polymarket CLOB order placement + fill tracking.

### Global mode switches
We will maintain **two independent global switches**:
- `paperTrading`: **ON/OFF** (existing engine; default ON).
- `liveTrading`: **OFF / ON** (default OFF).

Definitions:
- **OFF**: do not place live orders. Read-only live connectivity (positions/orders/fills) may still run to power the Real Portfolio and to detect external wallet activity.
- **ON**: place authenticated orders and track fills (plus all read-only live connectivity).

### Per-followed-user live switch
Per followed user, we maintain:
- `liveOverride`: `INHERIT | FORCE_ON | FORCE_OFF`

Effective live state:
- If global live is OFF → always OFF.
- Else global is ON → apply per-user override if set, otherwise inherit.

### Behavioral matrix (high level)
- Paper ON, Live OFF → **exact current behavior**.
- Paper ON, Live ON → paper executes; live executes (two parallel outcomes).
- Paper OFF, Live ON → only live executes (useful once confident).

---

## 3) Architecture: shared decision engine, mode-specific executors

### Shared pipeline (paper + live)
1) Ingest leader events → normalize to `LeaderTradeEvent`
2) Group/batch (existing aggregator + optional small-trade buffering)
3) **Decision engine (shared)**:
   - sizing mode: FIXED_RATE (MVP; budgeted dynamic is currently disabled and will require a redesign to re-enable)
   - trade-level clamps (min/max notional; % bankroll cap)
   - guardrails (spread, depth, price protection, “no new opens near close”, circuit breakers)
4) Emit a single **CopyIntent** (in-memory object, and/or persisted record) that represents *the decision*, independent of execution mode.

### Canonical identifiers and units (app-wide)
Polymarket data and our DB already use “micros” conventions; live trading must follow them exactly:
- `tokenId` (this doc) == `assetId` in the DB/code (outcome token ID as a string, often a large integer).
- `priceMicros`: `Int` in `[0 .. 1_000_000]` representing USDC-per-share × 1e6.
- `shareMicros`: `BigInt` representing shares × 1e6.
- `notionalMicros`: `BigInt` representing USDC × 1e6.
- Derived notional uses the same convention used elsewhere: `notionalMicros ≈ (shareMicros * priceMicros) / 1_000_000`.

### Live order identifiers (must be persisted)
We need stable IDs to dedupe, reconcile, and attribute fills:
- `idempotencyKey`: deterministic per CopyIntent (“same intended copy trade”).
- `clientOrderId` (optional): client-supplied identifier we may include in create-order requests if supported; stored for debugging/correlation only (do **not** assume the exchange lets us query orders by it).
- `clobOrderId`: exchange-assigned order id returned on successful placement and/or in user-channel events.
- `tradeId`: exchange-assigned trade/fill id from the user channel (must be unique and stable).

### CopyIntent (conceptual contract)
A CopyIntent must contain enough information to execute both paper and live deterministically:
- Identity:
  - `followedUserId`
  - `tokenId` (outcome token / `asset_id`)
  - `side` (BUY/SELL)
  - `sourceType` (IMMEDIATE / BUFFER / AGGREGATOR)
  - `groupKey` (stable aggregation key)
  - `idempotencyKey` (**deterministic**, derived from stable inputs; see below)
- Sizing:
  - `targetNotionalMicros`
  - `targetShareMicros` (derived; used for live order size)
  - metadata for observability (clamp flags; future: budgeted-dynamic effectiveRateBps)
- Price protections (guardrail bounds):
  - `maxBuyPriceMicros` (BUY) or `minSellPriceMicros` (SELL)
  - `theirReferencePriceMicros` (leader VWAP)
  - `midPriceMicrosAtDecision` (from freshest book)
- Decision:
  - `decision` (EXECUTE/SKIP) + `reasonCodes[]`

### Idempotency (non-negotiable)
Every CopyIntent must have an `idempotencyKey` that is:
- deterministic from the inputs that define “same intended copy trade”
- stable across retries, restarts, and worker duplicates

Decision (MVP): derive from the same uniqueness basis we already use for paper:
- `idempotencyKey = hash(followedUserId, tokenId, side, groupKey, modeIndependentVersion)`

Implementation requirements:
- The hash must be stable and compact (e.g., `sha256` of a stable string, encoded base64url/hex).
- Include an explicit version prefix so we can change the key basis later without collisions (e.g., `v1_<hash>`).
- `clientOrderId` is optional:
  - If create-order supports it, set `clientOrderId = idempotencyKey` (or a shortened/encoded form if the exchange constrains length/charset).
  - Store it for debugging/correlation, but do not build reconciliation that requires querying by `clientOrderId`.

The **live executor** must use this key to prevent duplicate order placement (see §6).

### Executors (mode-specific)
- **PaperExecutor** (existing): simulate fills vs normalized book snapshot; persist paper fills + ledger entries.
- **LiveExecutor** (new): compute tick/min-size compliant order params; place authenticated order; track lifecycle via user-channel WS; persist orders/fills; write live ledger entries.

---

## 4) Polymarket CLOB execution requirements (live)

### What we trade
- Orders are placed on **outcome tokens** (`tokenId` / `asset_id`).
- YES and NO are different `tokenId`s for the same market.

### Order types
We will support:
- **FAK** (default for copy trading): immediate partials allowed; remainder cancels.
- **FOK** (optional): “all or nothing”; used for reconcile/correction flows.
- **GTC**: not used in MVP unless explicitly enabled (resting orders increase operational risk).

### Constraints we must enforce before placing an order
For every live order we must respect:
- **tick size** (price increments) → otherwise `INVALID_ORDER_MIN_TICK_SIZE`
- **minimum order size** → otherwise `INVALID_ORDER_MIN_SIZE`
- optional `postOnly` constraints → otherwise `INVALID_ORDER_POST_ONLY` (MVP: keep `postOnly=false`)

### Required per-token trading params (tick/min/step)
To avoid “invalid order” rejections, LiveExecutor must have per-token trading params:
- `tickSizeMicros` (price step)
- `minOrderSizeShareMicros` (minimum size)
- `sizeStepShareMicros` (size step)

Source of truth:
- Polymarket CLOB market metadata (see references in §10):
  - `minimum_tick_size` (price tick)
  - `minimum_order_size` (min shares)

MVP assumption:
- Size step is **1 micro-share** (`sizeStepShareMicros = 1`) unless we observe a real exchange rejection implying a coarser step. If we observe it, we extend the cache schema and round to the enforced step.

Caching strategy (MVP):
- Persist the latest known params in a DB cache table (e.g., `TokenTradingParamsCache` keyed by `tokenId`) and keep a short-lived in-memory cache in the worker.
- Derivation:
  - Use `TokenMetadataCache.conditionId` for the token.
  - If `conditionId` is missing, attempt to derive it via existing enrichment and persist it to `TokenMetadataCache`; fail closed if we still cannot determine it.
  - Fetch MarketInfo for the condition and read `minimum_tick_size` + `minimum_order_size`.
  - Write the derived params to `TokenTradingParamsCache` for all outcome tokens in that condition.
- Refresh policy:
  - On-demand when a token is first traded.
  - Periodically (e.g., every 6–24 hours) to handle parameter changes.
- Fail closed: if params are missing/unknown, **SKIP** the live order and surface a clear reason code + alert in Live Trades.

### Book freshness requirements (live)
Live execution decisions must be based on a fresh book snapshot:
- Prefer the existing market-channel WS cache (via `bookService`) when enabled; otherwise use REST.
- **Crossed books are invalid:** if a book snapshot ever has `bestBidMicros > bestAskMicros`, treat it as unusable (this can happen transiently with WS updates). In that case:
  - wait briefly for WS to recover (up to `liveBookWaitMs`), otherwise
  - fall back to a REST book fetch for the decision.
- Require `bookAgeMs <= liveBookFreshnessMs` (MVP default: 2000ms). If stale:
  - wait briefly for WS freshness (MVP default: 500ms), or
  - SKIP with an explicit reason code if we cannot obtain a fresh book.
- Persist the decision-time `bestBid`, `bestAsk`, book source (WS/REST), and book age for audit/debug.
- Persist whether we had to fall back to REST due to WS invalidity/staleness (in current code this is `CopyAttempt.usedRestFallback`).

### Practical live execution policy (MVP)
Default: **FAK with a slippage cap**, while still respecting decision-engine price bounds.

For BUY:
- Base off best ask from freshest book.
- Compute `maxAllowed = min(decision.maxBuyPriceMicros, bestAsk * (1 + liveSlippageBpsBuy))`.
- If `maxAllowed < bestAsk`, **SKIP** (order would not be marketable within bounds).
- Place `FAK` BUY limit with:
  - `price = floorToTick(maxAllowed)` (BUY tick rounding: floor)
  - `size = floorToStep(targetShareMicros)` (size/notional rounding: floor)
- Post-rounding marketability check: if `price < bestAsk`, **SKIP** (not marketable after tick rounding).

For SELL:
- Base off best bid from freshest book.
- Compute `minAllowed = max(decision.minSellPriceMicros, bestBid * (1 - liveSlippageBpsSell))`.
- If `minAllowed > bestBid`, **SKIP** (order would not be marketable within bounds).
- Place `FAK` SELL limit with:
  - `price = ceilToTick(minAllowed)` (SELL tick rounding: ceil)
  - `size = floorToStep(targetShareMicros)` (size/notional rounding: floor)
- Post-rounding marketability check: if `price > bestBid`, **SKIP** (not marketable after tick rounding).

Min constraints:
- If `roundedSize < minimum_order_size`, **SKIP** (MVP behavior); revisit netting/aggregation only if this is frequent.
- If Polymarket rejects due to tick/min size despite our pre-checks, persist as a rejection with explicit reason codes and **do not** auto-retry with modified params.

Inventory constraints (authoritative live wallet state):
- BUY requires sufficient cash:
  - Compute `requiredNotionalMicros` from the rounded `price` and `size`.
  - If available cash is insufficient, shrink `size` down to what is affordable (still flooring to size step).
  - If the shrunk size drops below minimum size, **SKIP** with an explicit reason code.
- SELL requires sufficient position:
  - If available shares are insufficient, shrink `size` down to available shares (floor to size step).
  - If the shrunk size drops below minimum size, **SKIP** (use `NOT_ENOUGH_POSITION_TO_SELL` or a live-specific reason code).

SELL tolerance settings:
- Live config must support separate BUY vs SELL tolerances (at minimum `liveSlippageBpsBuy` and `liveSlippageBpsSell`).
- Live config may also allow SELL-side overrides for price protection (to reduce “missed leader sells”), while keeping BUY-side protections stricter.

If rounding causes the order to violate bounds or become non-marketable, the live executor must **SKIP** with an explicit reason code.

### Live skip/reject reason codes (MVP additions)
We will keep a single reason-code taxonomy for both paper and live. Add live-specific codes where needed (examples):
- `LIVE_NO_FRESH_BOOK`
- `LIVE_NOT_MARKETABLE_WITHIN_BOUNDS`
- `LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING`
- `LIVE_BELOW_MIN_ORDER_SIZE`
- `LIVE_INVALID_TICK_OR_STEP` (should be rare if metadata cache is correct)
- `LIVE_INSUFFICIENT_CASH_TO_BUY`
- `LIVE_ORDER_REJECTED_<ERROR_CODE>` (normalized, not raw free-text)

---

## 5) Data model & persistence (macro changes)

The key requirement is **true parallelism**: paper and live records must never collide, and every UI/query must be able to request “paper vs live”.

### Decision: introduce an explicit `TradingMode` dimension
We will represent “paper vs live” as a first-class dimension:
- `TradingMode = PAPER | LIVE`

This mode will be carried through:
- configs (paper settings vs live settings)
- attempts/executions (paper trades vs live trades)
- portfolio/ledger (paper portfolio vs real portfolio)

### Attempts and executions
We will treat the current `CopyAttempt` concept as the “decision + execution outcome” record, but extend it to work in parallel.

Macro spec:
- `CopyAttempt` gains `tradingMode: TradingMode`
- Uniqueness becomes:
  - `(tradingMode, portfolioScope, followedUserId, groupKey)` to allow both paper + live for the same group.
- Book provenance (required for realism/safety; these fields already exist on `CopyAttempt` today):
  - `bookSource: WS | REST`
  - `usedRestFallback: boolean` (true when WS was stale/invalid/crossed and we had to fetch a REST book)

Live-specific persistence (new tables):
- `LiveOrder`
  - references the corresponding `CopyAttempt` (where `tradingMode=LIVE`)
  - stores (minimum):
    - identifiers: `idempotencyKey`, `clientOrderId`, `clobOrderId`
    - order params: `tokenId`, `side`, `orderType`, `limitPriceMicros`, `sizeShareMicros`
    - decision snapshot: `bestBidMicrosAtDecision`, `bestAskMicrosAtDecision`, `bookSource`, `bookAgeMs`
    - fill tracking: `filledShareMicros`, `filledNotionalMicros`, `avgFillPriceMicros`
    - lifecycle: `status`, timestamps (`createdAt`, `submittedAt`, `lastUpdateAt`, `finalizedAt`)
    - error fields: `lastErrorCode`, `lastErrorMessage`
  - DB constraints (MVP):
    - `UNIQUE(idempotencyKey)` (hard app-level dedupe)
    - `UNIQUE(clientOrderId)` (if we use it)
    - `UNIQUE(clobOrderId)` (nullable unique)
    - indexes on `(createdAt)`, `(status)`, `(tokenId, createdAt)`
- `LiveFill`
  - may reference `LiveOrder` (nullable) so we can persist **EXTERNAL** fills/trades too
  - stores (minimum): `tradeId`, `clobOrderId`, `tokenId`, `side`, `matchedAt`, `priceMicros`, `shareMicros`, `notionalMicros`, `feeMicros?`, `status`, `origin=APP|EXTERNAL`
  - DB constraints (MVP):
    - `UNIQUE(tradeId)`
    - index on `(matchedAt)`, `(clobOrderId)`

Supporting caches/snapshots (required for correct live trading + UI):
- `TokenTradingParamsCache` (new): per-token tick/min/step params (see §4).
- Prices (shared across paper + live):
  - `CurrentPrice`: guaranteed 1-row-per-assetId “current mark” lookup (used for portfolio valuation).
- Portfolio read models (paper already uses these; live should have parallel rows keyed by `tradingMode`):
  - `GlobalPortfolioState(tradingMode, portfolioScope=EXEC_GLOBAL)` (cash + contributed capital/baseline)
  - `CurrentPosition(tradingMode, assetId)` (net shares + net cashflow by asset)
  - `CurrentPositionByLeader(tradingMode, assetId, followedUserId)` (attribution slices; multiple leaders can contribute to the same asset)
  - `EquityPoint(tradingMode, granularity, bucketTime)` (multi-resolution equity/PnL time-series)
- (Recommended for audit/debug) Authoritative raw snapshots from the exchange:
  - `RealPositionSnapshot` (new): latest/bucketed per-token positions as returned by the exchange (`tokenId`, `shareMicros`, `updatedAt`)
  - These snapshots are used to detect drift between exchange positions and our `LIVE` ledger/caches.

### Portfolio & ledger separation
We need two independent portfolios:
- **Paper Portfolio**: derived from simulated fills (current behavior)
- **Real Portfolio**: derived from **Polymarket account positions** (authoritative), with our live fills/ledger used for auditing.

Macro spec:
- `LedgerEntry` gains `tradingMode: TradingMode`
- Portfolio read models gain `tradingMode: TradingMode` so paper vs live can run in parallel without collisions:
  - `GlobalPortfolioState`: `(tradingMode, portfolioScope)`
  - `CurrentPosition`: `(tradingMode, assetId)`
  - `CurrentPositionByLeader`: `(tradingMode, assetId, followedUserId)`
  - `EquityPoint`: `(tradingMode, granularity, bucketTime)`
- Uniqueness becomes mode-aware:
  - `LedgerEntry`: `(tradingMode, portfolioScope, refId, entryType)`

Notes:
- Current code reality (Feb 2026):
  - Paper execution writes `PortfolioScope=EXEC_GLOBAL` only.
  - `PortfolioScope.SHADOW_USER` is deprecated/unused and must not be relied on for sizing or risk.
  - `PortfolioScope.EXEC_USER` is legacy and not used for portfolio computation; per-leader attribution is via `followedUserId` + `CurrentPositionByLeader`.
- For live MVP, execution is a **single global portfolio** (single wallet).
- Attribution in a single wallet:
  - Every app-placed live order/fill is tagged with `followedUserId` (on `CopyAttempt`, `LiveOrder`, ledger entries).
  - Per-user “slices” are computed exactly like today for `EXEC_GLOBAL + followedUserId` portfolios: by filtering `LedgerEntry(tradingMode=LIVE, portfolioScope=EXEC_GLOBAL, followedUserId=<user>)`.
  - Any fills/trades that cannot be linked to a `LiveOrder` are persisted as **EXTERNAL**:
    - `LiveFill.origin=EXTERNAL`, `followedUserId=NULL` for accounting attribution
    - ledger entries in `LIVE/EXEC_GLOBAL` with `followedUserId=NULL` so global exposure is correct while per-user slices exclude external.
- Polymarket positions are the source of truth:
  - We periodically fetch positions (and cash if available) and persist authoritative snapshots.
  - We compare exchange positions vs our internal `LIVE` ledger-projected positions and surface diffs (debug/audit signal).

### Real Portfolio baseline (PnL semantics)
Because the live execution wallet may already have cash/positions, the Real Portfolio must define a baseline:
- On the first successful live reconciliation, if no baseline exists:
  - set `liveBaselineTime` = current minute bucket
  - set `liveBaselineEquityMicros` and record baseline positions (from exchange + mark prices)
- All Real Portfolio PnL is shown as “since baseline”:
  - `totalPnlMicros = currentEquityMicros - liveBaselineEquityMicros - netDepositsSinceBaselineMicros`
  - If we do not implement deposit tracking in MVP, display a warning that PnL assumes no external deposits/withdrawals since baseline.
- Baseline reset is an explicit admin action (button) that records a new baseline.

### Live ledger entry rules (MVP)
We maintain a `LIVE` ledger primarily for attribution, audit, and PnL breakdown:
- On every `LiveFill`, upsert a `LedgerEntry(tradingMode=LIVE, entryType=TRADE_FILL, refId=tradeId)`:
  - `portfolioScope = EXEC_GLOBAL`
  - `followedUserId = LiveOrder.followedUserId` if `origin=APP`, else `NULL`
  - `assetId = tokenId`, `marketId` from `TokenMetadataCache` when available
  - BUY: `shareDeltaMicros = +shareMicros`, `cashDeltaMicros = -(notionalMicros + feeMicros?)`
  - SELL: `shareDeltaMicros = -shareMicros`, `cashDeltaMicros = +(notionalMicros - feeMicros?)`
  - `priceMicros = fill price`
- Fee handling:
  - MVP: include fees directly in `cashDeltaMicros` (no separate FEE entry), and display fee fields from `LiveFill` in the UI.
  - If we later want explicit fee reporting, add a separate `LedgerEntryType.FEE` entry keyed by `tradeId`.

### Settings/config separation
We will support separate configs for paper vs live:
- `GuardrailConfig` gains `tradingMode: TradingMode`
- `CopySizingConfig` gains `tradingMode: TradingMode`
- `SystemConfig` expands to include both paper and live global switches.

---

## 6) Live execution correctness: idempotency, retries, lifecycle

### LiveOrder status state machine (MVP)
We will persist a small, explicit status machine so UI and retries are unambiguous:
- `CREATED`: DB row created (decision recorded), not yet submitted.
- `SUBMITTING`: API call in-flight.
- `OPEN`: order accepted/open on the exchange.
- `PARTIAL`: some fills recorded, not fully filled.
- `FILLED`: fully filled.
- `CANCELED`: canceled (includes FAK remainder cancellation).
- `REJECTED`: exchange rejected the order request (validation, auth, etc.).
- `FAILED`: our system failed before submission (e.g., missing metadata) and will not place.
- `SUBMISSION_UNKNOWN`: we attempted submission but cannot confirm if the exchange accepted it (timeout/connection drop). Requires reconciliation before any further action.

### Order placement idempotency
LiveExecutor rules:
- Create-or-get `LiveOrder` by `idempotencyKey` inside a DB transaction.
  - If it already exists, do **not** place again; continue lifecycle tracking.
- Always persist the `LiveOrder` row before attempting the network call so we never “lose” an intent on crash.

### In-flight reservations and submission serialization (MVP)
To avoid oversubscribing cash or shares, live submissions must be serialized and use a lightweight reservation layer:
- **Concurrency = 1 per live wallet** for order placement (use a per-wallet queue/mutex).
- Maintain a `LiveAccountStateCache` with:
  - `cashAvailableMicros`, `reservedCashMicros`
  - `sharesAvailableMicrosByTokenId[tokenId]`, `reservedSharesMicrosByTokenId[tokenId]`
- Reservation rules:
  - Before submission, reserve based on the **rounded** order params.
  - BUY reserves worst-case cash = `limitPriceMicros * sizeShareMicros / 1_000_000` (plus a small fee buffer if fees are charged at fill time).
  - SELL reserves `sizeShareMicros`.
  - Release/adjust reservations on user-channel fills/cancel/finalization and during reconciliation.
- If we cannot reconcile a submission outcome (`SUBMISSION_UNKNOWN`), **pause further live submissions** until resolved or manually cleared.

### Retries
Retries must be safe:
- Retry placement only if we can prove “no exchange order exists for this intent”.
  - Preferred proof: exchange lookup by `clobOrderId` (Get Order and/or open orders endpoints).
  - If `clobOrderId` is unknown (`SUBMISSION_UNKNOWN`), resolve via reconciliation by scanning open orders + recent trades and matching the single in-flight submission (serialization makes this tractable).
- Never retry blindly on timeouts:
  - If the submission outcome is uncertain, move the order to `SUBMISSION_UNKNOWN` and reconcile first.

### User-channel WS is the source for order/fill lifecycle
Live fills must be tracked via the Polymarket **User Channel** websocket:
- persist status transitions for orders (OPEN → PARTIAL → FILLED/CANCELED/REJECTED)
- persist fills with a stable exchange `tradeId`

Lifecycle event handling requirements:
- Order placement response:
  - On success: persist `clobOrderId`, set status to `OPEN` (or `OPEN`/`PARTIAL` if the response includes fills).
  - On known validation/auth failure: set status to `REJECTED` with normalized error code/message.
  - On timeout/unknown: set status to `SUBMISSION_UNKNOWN` and schedule immediate reconciliation.
- User-channel order updates:
  - Map exchange statuses into our `LiveOrder.status` without ambiguity (OPEN/PARTIAL/FILLED/CANCELED/REJECTED).
  - Always update `lastUpdateAt` and keep status monotonic (never move “backwards”).
- User-channel trade/fill updates:
  - `LiveFill.tradeId` must be unique (upsert by tradeId).
  - Update `LiveOrder.filledShareMicros`, `filledNotionalMicros`, and `avgFillPriceMicros` from fills.
  - Mark `PARTIAL` vs `FILLED` based on `filledShareMicros >= sizeShareMicros` (after rounding).

### Periodic reconciliation (required for safety)
Even with WS:
- Reconcile open orders:
  - interval (MVP default): 30–60s (configurable; rate-limited)
  - purpose: heal missed WS events, finalize stuck orders, resolve `SUBMISSION_UNKNOWN`
  - `SUBMISSION_UNKNOWN` handling:
    - since we do **not** rely on `clientOrderId` lookup, resolve by scanning open orders + recent trades and matching on (tokenId, side, rounded price, rounded size, time window)
    - if still unresolved after a bounded window (e.g., 5–10 minutes), mark as `FAILED`, alert, and require manual confirmation before further live order placement
- Reconcile positions/cash:
  - interval (MVP default): 60s (bucketed to minute boundary for snapshots)
  - purpose: drive Real Portfolio snapshots, enforce inventory checks, and detect discrepancies
  - source of truth (MVP):
    - prefer the official Polymarket TS client “L2 methods” for authenticated wallet state (cash/collateral/balances and positions where supported)
    - if positions are not available in the TS client version, fetch positions from the Polymarket Data API and map them to CLOB token IDs:
      - if the Data API returns `tokenId/asset_id`, join directly
      - otherwise, map via `TokenMetadataCache` (conditionId/market/outcome) and/or `OutcomeAsset` (marketId → tokenId) as needed
  - health gating:
    - if we cannot obtain fresh authoritative cash + positions, treat live as unhealthy and **do not place orders** even if `liveTrading=ON` (surface the error in Live Trades)
- Treat exchange positions as authoritative for Real Portfolio:
  - persist authoritative reconciliation into the LIVE portfolio read models (`CurrentPosition`, `GlobalPortfolioState`, `EquityPoint`) and optionally raw `RealPositionSnapshot`
  - record `lastReconciledAt` and surface it in Live Trades + Real Portfolio UI
- Ledger-vs-exchange diffs:
  - compute “ledger-projected positions” from `LedgerEntry(tradingMode=LIVE)` and compare to exchange positions
  - persist/surface diffs as a diagnostic signal (do not auto-correct positions in MVP)
- External activity detection:
  - any fills/trades observed via user channel or reconciliation that do not match a known `LiveOrder` are persisted as **EXTERNAL** and appear in Live Trades.

### Authoritative live wallet state for pre-trade checks
LiveExecutor needs a fast, consistent view of available cash and positions:
- Maintain an in-memory `LiveAccountStateCache` seeded from the latest authoritative reconciliation, tracking both **available** and **reserved** cash/shares (see reservations section above).
- Update it on user-channel trade/fill events and reservation actions (optimistic), then correct via reconciliation.
- Use this cache for BUY cash checks and SELL position checks and for shrink-to-affordable/shrink-to-available sizing (see §4 inventory constraints).

### Auth & signing (live)
- Use the official **Polymarket TS client** for key derivation/signing/authenticated order placement.

---

## 7) UI/UX spec (pages, navigation, and parity)

### Navigation changes (web)
We will restructure navigation to clearly separate paper vs live:
- Rename `/copy-attempts` → `/paper-trades`
- Rename `/portfolio` → `/paper-portfolio`
- Add `/live-trades`
- Add `/real-portfolio`

Back-compat:
- keep redirects from old routes (`/copy-attempts`, `/portfolio`) to the new ones (at least for one release cycle).

### Paper Trades (renamed Copy Attempts)
Goal: same as today, just renamed and framed as paper execution.
- Data: paper `CopyAttempt` records (and `ExecutableFill`s).
- UX: same filters (user/market/decision/reason), same pagination/refresh.
- Include a small badge/indicator when `CopyAttempt.usedRestFallback=true` (so operators can see WS→REST fallbacks at a glance).

### Paper Portfolio (renamed Portfolio)
Goal: same as today, but explicitly “paper”.
- Data (current code): paper portfolio read models (`GlobalPortfolioState`, `CurrentPosition`, `CurrentPositionByLeader`, `CurrentPrice`, `EquityPoint`) plus `TokenMetadataCache` for display.
- The header/labels should say “Paper Portfolio” (not “Executable Portfolio”).

### Live Trades (new)
Goal: operationally useful live view, “similar” to Paper Trades, plus live-specific tables.

At minimum, it contains:
- **Status panel**
  - Live trading global state (OFF/ON)
  - Paper trading state (ON/OFF)
  - Per-user live state summary (inherit/forced on/off)
  - CLOB auth status
  - WS status: user channel connected? market channel connected?
  - last user-channel event time; last reconcile time
  - open orders count; orders in `SUBMISSION_UNKNOWN` count
  - last order placed time; last error
- **Tables**
  1) Live Orders (one row per order attempt)
  2) Live Fills / Trades (one row per exchange fill; include an **origin** badge: APP vs EXTERNAL)
  3) Skipped / Rejected (live-mode copy attempts that did not place, with reason codes)
  4) Positions snapshot (from exchange-based Real Portfolio snapshots)
  - For any table row that depends on a decision-time book, include a small `WS`/`REST` indicator and whether a REST fallback was used.
- **Kill switches**
  - global emergency OFF for live
  - per-user OFF (force-off override)

### Real Portfolio (new)
Goal: show actual live trading portfolio, analogous to the Paper Portfolio.

Minimum content:
- headline metrics: equity, cash, exposure, realized/unrealized PnL, drawdown/risk utilization
- positions table: tokenId/outcome/market title, shares, mark price, market value, per-user attribution slices

Important UX note:
- The Real Portfolio page must clearly display whether it is based on:
  - **Polymarket positions** (authoritative), and
  - last reconciliation time vs exchange, plus any ledger-vs-exchange diffs
  - baseline time (“PnL since <baseline>”) so users know what the PnL curve represents

### Config page (paper vs live settings)
We will split config into two scopes:
- Paper config
- Live config

UI decision:
- Add a mode selector (tabs or segmented control) at the top of `/config`: **Paper | Live**
- Each mode shows the same major sections (guardrails, sizing, buffering), but values are stored separately.

Live-specific config additions (MVP):
- `liveSlippageBpsBuy`
- `liveSlippageBpsSell`
- optional SELL-side guardrail overrides (to be more tolerant on exits)
- default `liveOrderType` (FAK by default)
- optional “enable FOK for corrections” (off by default)

### Users page (per-user live override)
Add:
- a column/control for `liveOverride` (INHERIT/FORCE_ON/FORCE_OFF)
- (optional) separate `paperEnabled` vs `enabled` if we currently use `enabled` as “paper follow”

---

## 8) Ops, safety, and secrets

### Rollout
Rollout stages are productized, not ad-hoc:
- OFF → ON (execute)
- Start ON with conservative live limits (min/max notional, % bankroll cap) and enable for a small subset of followed users first.

### Kill switches
Required switches:
- live global emergency OFF (immediate)
- per-user force OFF
- paper global OFF (optional but supported)

### Secrets handling (hard rule)
- Live trading auth secrets must be provided at runtime via env vars / docker secrets.
- Never log secrets (including derived API key material).
- Do not bake secrets into images.

### Rate limits and backpressure
- Live authenticated endpoints must be rate-limited (separate limiter class from data/book requests).
- WS reconnect logic must be bounded and observable.

---

## 9) Decisions confirmed (so the spec is unambiguous)

1) Live executes only in a single **global** live portfolio (single wallet).
2) Real Portfolio is based on **Polymarket positions** as the source of truth; our `LIVE` ledger is used to audit and detect discrepancies.
3) Any fills/trades from that wallet **outside the app** must be shown and clearly labeled as **EXTERNAL** (portfolio still updates since it is exchange-based).
4) If an order is below min size (or fails due to min size), we **SKIP for now** and revisit netting/aggregation only if this becomes common.
5) Idempotency and identifiers:
   - `idempotencyKey` is deterministic and versioned.
   - `LiveOrder` is created-or-get by `idempotencyKey` before any network call.
   - `clientOrderId` may be stored/sent for debugging, but reconciliation is based on `clobOrderId` and open-orders/trades scanning (do not depend on `clientOrderId` queryability).
6) Rounding rules:
   - BUY price: **floor** to tick
   - SELL price: **ceil** to tick
   - Size/notional: **floor** to step for both BUY/SELL so we don’t exceed caps
   - If rounded size/notional is below minimum: **SKIP** (or future: defer to netting queue)
   - Provide SELL-side tolerance settings so we can be more aggressive about not missing exits if desired.
   - Post-rounding marketability check is required (BUY `price >= bestAsk`, SELL `price <= bestBid`).
7) Submission uncertainty handling:
   - Never “blind retry” a timed-out submission; use `SUBMISSION_UNKNOWN` + reconciliation.
8) Use the official **Polymarket TS client** for signing/auth.
9) Trading constraints:
   - Tick/min come from exchange metadata (`minimum_tick_size`, `minimum_order_size`) and are cached per token.
   - Size step defaults to `1` micro-share unless the exchange enforces otherwise.
10) Live submissions:
   - Serialize live order placement per wallet (concurrency=1) and use reservations to prevent oversubscription.
   - On `SUBMISSION_UNKNOWN`, pause further submissions until resolved or manually cleared.

---

## 10) References
- `live_trading_info.md` (primary planning fuel)
- Polymarket docs:
  - CLOB Introduction: https://docs.polymarket.com/developers/CLOB/introduction
  - CLOB Quickstart: https://docs.polymarket.com/developers/CLOB/quickstart
  - Orders: Create Order: https://docs.polymarket.com/developers/CLOB/orders/create-order
  - Orders: Get Order: https://docs.polymarket.com/developers/CLOB/orders/get-order
  - Orders (GTC/FAK/FOK + errors): https://docs.polymarket.com/developers/CLOB/orders/create-order
  - TS Client L2 methods: https://docs.polymarket.com/developers/CLOB/clients/methods-l2
  - Websocket — User Channel: https://docs.polymarket.com/developers/CLOB/websocket/user-channel
  - Websocket — Market Channel: https://docs.polymarket.com/developers/CLOB/websocket/market-channel
  - API Rate Limits: https://docs.polymarket.com/quickstart/introduction/rate-limits
  - Bridge overview: https://docs.polymarket.com/developers/misc-endpoints/bridge-overview
  - Proxy wallet: https://docs.polymarket.com/developers/proxy-wallet
