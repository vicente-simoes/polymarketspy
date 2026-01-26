# Live Trading Mode — Implementation Spec (Parallel to Paper)

This document is the **source-of-truth spec** for adding **Live Trading Mode** to PolymarketSpy, following `live_trading_info.md` and the additional UX requirements from this request. This is **not** a step-by-step build guide; it defines the **macro decisions**, **system behavior**, and **interfaces/data** we will later implement.

---

## 0) Goals / Non-goals

### Goals
- Add a **fully parallel** live execution path that can be **enabled/disabled**:
  - **Global** live state (OFF / SHADOW / ON).
  - **Per-followed-user** live override (INHERIT / FORCE_ON / FORCE_OFF).
- Keep **paper trading behavior unchanged** when live is OFF.
- Keep the **strategy/decision logic shared** between paper + live wherever feasible; swap only the **execution adapter**.
- Add new UI surfaces:
  - Rename current **Copy Attempts** page → **Paper Trades** (same functionality).
  - Rename current **Portfolio** page → **Paper Portfolio** (same functionality).
  - Add **Live Trades** page (paper-trades-like, but for live orders/fills/skips).
  - Add **Real Portfolio** page (live portfolio view).
- Provide **separate settings** for paper vs live when it makes sense (guardrails, sizing, buffering, system toggles).
- Meet operational safety requirements (shadow mode, idempotency, kill switches, secrets hygiene).

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
- `liveTrading`: **OFF / SHADOW / ON** (default OFF).

Definitions:
- **OFF**: no live orders are produced/recorded (other than optional metrics).
- **SHADOW**: generate/record “would place order” artifacts, but **place nothing**.
- **ON**: place authenticated orders and track fills.

### Per-followed-user live switch
Per followed user, we maintain:
- `liveOverride`: `INHERIT | FORCE_ON | FORCE_OFF`

Effective live state:
- If global live is OFF → always OFF.
- Else global is SHADOW/ON → apply per-user override if set, otherwise inherit.

### Behavioral matrix (high level)
- Paper ON, Live OFF → **exact current behavior**.
- Paper ON, Live SHADOW → paper executes; live records “would have placed”.
- Paper ON, Live ON → paper executes; live executes (two parallel outcomes).
- Paper OFF, Live ON → only live executes (useful once confident).

---

## 3) Architecture: shared decision engine, mode-specific executors

### Shared pipeline (paper + live)
1) Ingest leader events → normalize to `LeaderTradeEvent`
2) Group/batch (existing aggregator + optional small-trade buffering)
3) **Decision engine (shared)**:
   - sizing mode: FIXED_RATE or BUDGETED_DYNAMIC
   - trade-level clamps (min/max notional; % bankroll cap)
   - guardrails (spread, depth, price protection, “no new opens near close”, circuit breakers)
4) Emit a single **CopyIntent** (in-memory object, and/or persisted record) that represents *the decision*, independent of execution mode.

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
  - metadata for observability (effectiveRateBps for budgeted dynamic, clamp flags)
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

### Practical live execution policy (MVP)
Default: **FAK with a slippage cap**, while still respecting decision-engine price bounds.

For BUY:
- Base off best ask from freshest book.
- Compute `maxAllowed = min(decision.maxBuyPriceMicros, bestAsk * (1 + liveSlippageBpsBuy))`.
- If `maxAllowed < bestAsk`, **SKIP** (order would not be marketable within bounds).
- Place `FAK` BUY limit with:
  - `price = floorToTick(maxAllowed)` (BUY tick rounding: floor)
  - `size = floorToStep(targetShareMicros)` (size/notional rounding: floor)

For SELL:
- Base off best bid from freshest book.
- Compute `minAllowed = max(decision.minSellPriceMicros, bestBid * (1 - liveSlippageBpsSell))`.
- If `minAllowed > bestBid`, **SKIP** (order would not be marketable within bounds).
- Place `FAK` SELL limit with:
  - `price = ceilToTick(minAllowed)` (SELL tick rounding: ceil)
  - `size = floorToStep(targetShareMicros)` (size/notional rounding: floor)

Min constraints:
- If `roundedSize < minimum_order_size`, **SKIP** (MVP behavior); revisit netting/aggregation only if this is frequent.
- If Polymarket rejects due to tick/min size despite our pre-checks, persist as a rejection with explicit reason codes and **do not** auto-retry with modified params.

SELL tolerance settings:
- Live config must support separate BUY vs SELL tolerances (at minimum `liveSlippageBpsBuy` and `liveSlippageBpsSell`).
- Live config may also allow SELL-side overrides for price protection (to reduce “missed leader sells”), while keeping BUY-side protections stricter.

If rounding causes the order to violate bounds, the live executor must **SKIP** with an explicit reason code.

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

Live-specific persistence (new tables):
- `LiveOrder`
  - references the corresponding `CopyAttempt` (where `tradingMode=LIVE`)
  - stores: `clobOrderId`, `clientOrderId/idempotencyKey`, `tokenId`, `side`, `price`, `size`, `orderType`, `status`, timestamps, last error
- `LiveFill`
  - may reference `LiveOrder` (nullable) so we can persist **EXTERNAL** fills/trades too
  - stores: `tradeId`, `clobOrderId`, `matchedAt`, `price`, `size`, `status`, `origin=APP|EXTERNAL`, fee fields if available

We will also persist “shadow orders” in `LiveOrder` when global live is SHADOW, marked as `shadow=true` (or status `SHADOW_ONLY`) with no `clobOrderId`.

### Portfolio & ledger separation
We need two independent portfolios:
- **Paper Portfolio**: derived from simulated fills (current behavior)
- **Real Portfolio**: derived from **Polymarket account positions** (authoritative), with our live fills/ledger used for auditing.

Macro spec:
- `LedgerEntry` gains `tradingMode: TradingMode`
- `PortfolioSnapshot` gains `tradingMode: TradingMode`
- Uniqueness becomes mode-aware:
  - `LedgerEntry`: `(tradingMode, portfolioScope, refId, entryType)`
  - `PortfolioSnapshot`: `(tradingMode, portfolioScope, followedUserId, bucketTime)`

Notes:
- We keep existing `portfolioScope` behavior (EXEC_GLOBAL/EXEC_USER) for paper as-is.
- For live MVP, execution is a **single global portfolio** (single wallet). We still attribute each app-generated order/fill to `followedUserId` so we can compute per-user exposure slices in the Real Portfolio page.
- Polymarket positions are the source of truth: we periodically fetch positions (and cash if available) and compare them against our internal live ledger to detect bugs or missing events.
- If the execution wallet trades outside PolymarketSpy, those fills/trades must be persisted and displayed as **EXTERNAL**, and they will naturally flow into the Real Portfolio since it is exchange-based.

### Settings/config separation
We will support separate configs for paper vs live:
- `GuardrailConfig` gains `tradingMode: TradingMode`
- `CopySizingConfig` gains `tradingMode: TradingMode`
- `SystemConfig` expands to include both paper and live global switches.

---

## 6) Live execution correctness: idempotency, retries, lifecycle

### Order placement idempotency
LiveExecutor rules:
- Before placing an order for a CopyIntent, check if a `LiveOrder` already exists for `(idempotencyKey)`.
  - If it exists with a `clobOrderId`, do **not** place again; continue lifecycle tracking.
  - If it exists as shadow-only and global mode is now ON, decide whether to “upgrade” (MVP: create a new LiveOrder record for ON; do not mutate historical shadow artifacts).

### Retries
Retries must be safe:
- retry placement only if we can prove “no order exists” (by our DB + optional exchange lookup by clientOrderId if supported)
- never retry blindly on timeouts

### User-channel WS is the source for order/fill lifecycle
Live fills must be tracked via the Polymarket **User Channel** websocket:
- persist status transitions for orders (OPEN → PARTIAL → FILLED/CANCELED/REJECTED)
- persist fills with a stable exchange `tradeId`

### Periodic reconciliation (required for safety)
Even with WS:
- periodically reconcile open orders and positions via REST endpoints (rate-limited)
- treat exchange positions as authoritative for Real Portfolio snapshots
- compare exchange positions vs our internal `LIVE` ledger-projected positions and persist any diffs (audit/debug signal)
- detect and label any fills/trades that are not linked to a `LiveOrder` as **EXTERNAL**

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

### Paper Portfolio (renamed Portfolio)
Goal: same as today, but explicitly “paper”.
- Data: paper `PortfolioSnapshot` + paper `LedgerEntry` aggregation.
- The header/labels should say “Paper Portfolio” (not “Executable Portfolio”).

### Live Trades (new)
Goal: operationally useful live view, “similar” to Paper Trades, plus live-specific tables.

At minimum, it contains:
- **Status panel**
  - Live trading global state (OFF/SHADOW/ON)
  - Paper trading state (ON/OFF)
  - Per-user live state summary (inherit/forced on/off)
  - CLOB auth status
  - WS status: user channel connected? market channel connected?
  - last order placed time; last error
- **Tables**
  1) Live Orders (one row per order attempt)
  2) Live Fills / Trades (one row per exchange fill; include an **origin** badge: APP vs EXTERNAL)
  3) Skipped / Rejected (live-mode copy attempts that did not place, with reason codes)
  4) Positions snapshot (from exchange-based Real Portfolio snapshots)
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

### Shadow mode first
Rollout stages are productized, not ad-hoc:
- OFF → SHADOW (observe) → ON (execute)

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
5) Rounding rules:
   - BUY price: **floor** to tick
   - SELL price: **ceil** to tick
   - Size/notional: **floor** to step for both BUY/SELL so we don’t exceed caps
   - If rounded size/notional is below minimum: **SKIP** (or future: defer to netting queue)
   - Provide SELL-side tolerance settings so we can be more aggressive about not missing exits if desired.
6) Use the official **Polymarket TS client** for signing/auth.

---

## 10) References
- `live_trading_info.md` (primary planning fuel)
- Polymarket CLOB docs (overview, order management, user channel, market channel, rate limits)
- Proxy wallet docs (if we decide to use proxy wallets for execution)
