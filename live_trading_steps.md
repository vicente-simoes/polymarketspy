# Live Trading Mode — Implementation Steps (Detailed)

Source of truth: `live_trading_plan.md` (spec) + `live_trading_info.md` (reference context).

Goal of this document: an explicit, step-by-step implementation sequence for the current codebase so that, when complete, Paper + Live run fully in parallel, new pages exist, Real Portfolio is exchange-based, and safety/idempotency requirements are met.

---

## Phase 0 — Baseline + guardrails (do this first)

1) **Create a baseline “green” checkpoint**
   - Run: `pnpm -C apps/worker test`, `pnpm -C apps/worker typecheck`, `pnpm -C apps/web typecheck`, `pnpm lint`
   - If anything fails on main, document it before proceeding (don’t mix unrelated fixes into this project).

2) **Confirm default rollout posture**
   - Default `liveTradingState = OFF`
   - Default `paperTradingEnabled = ON` (current behavior)
   - Default per-user live override = `INHERIT`

3) **Decide naming/constants now (keep consistent across DB + shared + UI)**
   - `TradingMode = PAPER | LIVE`
   - `LiveTradingState = OFF | SHADOW | ON` (stored in system config)
   - `LiveOverride = INHERIT | FORCE_ON | FORCE_OFF` (stored per followed user)

---

## Phase 1 — Shared types & reason codes

### 1.1 Add mode enums and live settings types (`packages/shared`)

1) Update `packages/shared/src/config.ts`
   - Extend `SystemConfigSchema` with:
     - `liveTradingState: z.enum(["OFF","SHADOW","ON"])` (default OFF)
   - Treat existing `copyEngineEnabled` as the **paper trading** global toggle (no schema rename needed; just rename in UI).
   - Add a new schema for live execution settings (separate from guardrails/sizing):
     - `LiveExecutionSchema` with `liveSlippageBpsBuy`, `liveSlippageBpsSell`, optional SELL-side overrides (as per `live_trading_plan.md`)

2) Update `packages/shared/src/index.ts`
   - Export the new schema/types and any new enums.

3) Update `packages/shared/src/reasonCodes.ts`
   - Add live-specific reason codes (examples; keep locked list small and explicit):
     - `LIVE_MODE_OFF`
     - `LIVE_SHADOW_ONLY`
     - `LIVE_AUTH_MISSING`
     - `LIVE_ORDER_NOT_MARKETABLE_WITHIN_BOUNDS`
     - `LIVE_BELOW_MIN_ORDER_SIZE`
     - `LIVE_TICK_ROUNDING_VIOLATES_BOUNDS`
     - `LIVE_ORDER_REJECTED`
     - `LIVE_ORDER_FAILED`
     - `LIVE_WS_NOT_CONNECTED` (if we choose to block execution when user WS is down)

### 1.2 Tests (shared)

4) Run: `pnpm -C packages/shared typecheck` and `pnpm -C packages/shared build`

---

## Phase 2 — Database schema (Prisma) + migrations

### 2.1 Add core “mode” dimension everywhere it must be parallel

1) Update `prisma/schema.prisma`
   - Add enum `TradingMode { PAPER LIVE }`
   - Add enum `LiveOverride { INHERIT FORCE_ON FORCE_OFF }`

2) Add `tradingMode TradingMode @default(PAPER)` to:
   - `GuardrailConfig`
   - `CopySizingConfig`
   - `CopyAttempt`
   - `LedgerEntry`
   - `PortfolioSnapshot`

3) Update uniques/indexes to be mode-aware
   - `CopyAttempt`: unique becomes `(tradingMode, portfolioScope, followedUserId, groupKey)`
   - `LedgerEntry`: unique becomes `(tradingMode, portfolioScope, refId, entryType)`
   - `PortfolioSnapshot`: unique becomes `(tradingMode, portfolioScope, followedUserId, bucketTime)`
   - Add indexes that will be heavily queried from UI:
     - `CopyAttempt(tradingMode, portfolioScope, createdAt)`
     - `LedgerEntry(tradingMode, portfolioScope, createdAt)`
     - `PortfolioSnapshot(tradingMode, portfolioScope, bucketTime)`

4) Add `liveOverride LiveOverride @default(INHERIT)` to `FollowedUser`

### 2.2 Add live-specific persistence models

5) Add `LiveOrder` model (minimal MVP fields)
   - `id`
   - `copyAttemptId` (FK)
   - `idempotencyKey` (unique)
   - `tokenId`, `side`, `priceMicros`, `sizeMicros`, `orderType`
   - `status` + timestamps (`createdAt`, `submittedAt`, `lastUpdateAt`)
   - `clobOrderId` (nullable; set when placed; null in SHADOW)
   - `lastError` (nullable)
   - Index by `createdAt`, and by `status`

6) Add `LiveFill` model (supports APP + EXTERNAL)
   - `id`
   - `liveOrderId` (nullable FK)
   - `tradeId` (unique if provided by exchange)
   - `clobOrderId` (nullable)
   - `tokenId`, `side`, `priceMicros`, `sizeMicros`, `feeMicros?`
   - `matchedAt`
   - `origin` enum: `APP | EXTERNAL`
   - Index by `matchedAt`, and by `origin`

### 2.3 Real Portfolio snapshots (exchange-based)

7) Add models to persist exchange position snapshots (so the web never needs secrets)
   - Use `PortfolioSnapshot` with `tradingMode=LIVE` for the metric “header” record (equity/cash/exposure/etc).
   - `LivePositionSnapshot`
     - `bucketTime`
     - `tokenId`
     - `shareMicros` (or `sizeMicros`)
     - optional `avgEntryPriceMicros` if available
   - Keep `PortfolioSnapshot(tradingMode=LIVE, portfolioScope=EXEC_GLOBAL, followedUserId=null)` as the metric “header” record; the per-token rows live in `LivePositionSnapshot`.

8) Add a small “reconcile diff” table (optional but recommended for debugging)
   - `LivePositionDiffSnapshot` (bucketTime, tokenId, exchangeShares, ledgerShares, deltaShares)

### 2.4 Migration & generation

9) Run migration and regenerate clients
   - `pnpm prisma:migrate:dev --name live_trading_mode`
   - `pnpm prisma:generate`

10) Backfill / initialize
   - Ensure existing rows become `tradingMode=PAPER` via default + migration SQL.
   - Create initial LIVE config rows by copying existing PAPER configs:
     - Guardrails (GLOBAL + USER)
     - Sizing (GLOBAL + USER)
     - Small-trade buffering and any live execution config keys (see Phase 3)

11) Run: `pnpm -C apps/worker typecheck` (Prisma types will change everywhere).

---

## Phase 3 — Config plumbing (web + worker)

### 3.1 Make guardrails/sizing mode-aware in the worker

1) Update `apps/worker/src/simulate/config.ts`
   - Change `getGlobalConfig()` and `getUserConfig()` signatures to accept `tradingMode: TradingMode`
   - Query `GuardrailConfig` / `CopySizingConfig` filtered by `(scope, followedUserId, tradingMode)`
   - Split small-trade buffering by mode:
     - Store under `SystemCheckpoint` keys:
       - `config:smallTradeBuffering:PAPER`
       - `config:smallTradeBuffering:LIVE`
   - Add a new `SystemCheckpoint` key for live execution settings:
     - `config:liveExecution` (or `config:liveExecution:LIVE`)

2) Update every call site in `apps/worker/src/simulate/*` that reads config to pass the correct `TradingMode`

### 3.2 Make global system toggles mode-aware

3) Update `apps/worker/src/config/system.ts` + shared schema usage
   - Parse and expose:
     - paper trading enabled (`copyEngineEnabled`)
     - `liveTradingState`

4) Ensure the copy pipeline checks these toggles (Phase 4) before enqueuing work.

### 3.3 Web API: add “mode” parameter to config endpoints

5) Update `apps/web/src/app/api/config/global/route.ts`
   - Accept `mode=paper|live` (query param) for GET/POST.
   - Read/write `GuardrailConfig`/`CopySizingConfig` rows scoped by `tradingMode`.
   - Read/write small-trade buffering by key (`config:smallTradeBuffering:PAPER|LIVE`).
   - Read/write live execution config (`config:liveExecution`) only in live mode.
   - Extend system config updates to include paper/live toggles (stored in `system:config`).

6) Update `apps/web/src/app/api/config/user/[id]/route.ts`
   - Same mode-aware behavior for per-user guardrails/sizing.

### 3.4 Web UI: split config into Paper vs Live

7) Update `apps/web/src/app/config/page.tsx`
   - Add a top-level “Paper | Live” selector.
   - When Paper is selected:
     - show existing guardrails/sizing/buffering (paper keys)
   - When Live is selected:
     - show guardrails/sizing/buffering (live keys)
     - add `liveSlippageBpsBuy` / `liveSlippageBpsSell` and optional SELL-side overrides
   - Keep defaults aligned with `live_trading_plan.md`

### 3.5 Tests (config)

8) Add worker unit tests (vitest) for config selection:
   - `getUserConfig(followedUserId, PAPER)` doesn’t read LIVE rows and vice-versa
   - buffering keys are mode-separated

9) Run: `pnpm -C apps/worker test`

---

## Phase 4 — Mode-aware pipeline & orchestration (worker)

Goal: after this phase, we can create **two parallel CopyAttempts** from the same leader group: one PAPER (existing behavior), one LIVE (shadow-only placeholder for now).

1) Introduce a “mode” field in the job payload
   - Update `apps/worker/src/simulate/types.ts` job types to carry `tradingMode`
   - Update `apps/worker/src/simulate/processor.ts` (group events processor):
     - Load `SystemConfig` once (cache ok).
     - Decide whether to process PAPER and/or LIVE for this followed user:
       - PAPER if paper enabled
       - LIVE if `liveTradingState != OFF` and user override isn’t FORCE_OFF
     - Route each mode through its own buffering/aggregation decision using mode-aware config.

2) Keep paper behavior unchanged when live is OFF
   - Ensure the default path produces identical paper `CopyAttempt` rows as before (minus the new `tradingMode=PAPER` field).

3) Update `apps/worker/src/simulate/workers.ts` and `apps/worker/src/simulate/executor.ts`
   - Accept `tradingMode` and write `CopyAttempt.tradingMode`
   - For PAPER: keep current simulation and ledger behavior (only add the mode filter to DB writes)

4) Add per-user live override support
   - Read `FollowedUser.liveOverride` during enqueue decisions (processor stage)

### Tests (pipeline gating)

5) Add worker tests to assert:
   - LIVE attempts are not created when `liveTradingState=OFF`
   - LIVE attempts are created when `liveTradingState=SHADOW` and user is INHERIT/FORCE_ON
   - LIVE attempts are not created when user is FORCE_OFF

6) Run: `pnpm -C apps/worker test`

---

## Phase 5 — Live order execution (SHADOW then ON)

### 5.1 Implement LiveExecutor (new module)

1) Create `apps/worker/src/live/` modules (recommended split)
   - `client.ts`: wrapper around official Polymarket TS client (auth + request helpers)
   - `constraints.ts`: fetch/cache tick size + min size per token (via tokenMetadataCache → conditionId → market info)
   - `rounding.ts`: implement rounding rules from `live_trading_plan.md`:
     - BUY price: floor to tick
     - SELL price: ceil to tick
     - size: floor to step
   - `executor.ts`: place orders (or shadow), persist `LiveOrder`, and handle idempotency

2) Add env vars in `apps/worker/src/config/env.ts` (and wire to docker)
   - The exact variables depend on the official TS client, but must include:
     - wallet/private key material (or signer seed)
     - any derived API key/passphrase/secret if required
   - Ensure no secrets are logged (ever).

3) Implement live order parameter derivation in `apps/worker/src/live/executor.ts`
   - Input: `CopyIntent` (tokenId, side, targetShareMicros, bounds, etc.) + live execution config
   - Fetch the freshest book via existing `apps/worker/src/simulate/bookService.ts`
   - Compute `maxAllowed/minAllowed` with separate BUY/SELL slippage bps
   - Apply rounding rules and min constraints
   - If invalid → SKIP with explicit live reason code

4) Implement idempotency for live placement
   - Uniquely key live orders by `idempotencyKey`
   - Before placing:
     - If a `LiveOrder` already exists with `clobOrderId`, do not place again.
     - If it exists in SHADOW history, create a new order record when in ON (don’t mutate history).

### 5.2 Wire LiveExecutor into the execution worker

5) Update `apps/worker/src/simulate/workers.ts`
   - For `tradingMode=LIVE`:
     - If `liveTradingState=SHADOW`: persist `CopyAttempt(LIVE)` + `LiveOrder(status=SHADOW_ONLY)` only.
     - If `liveTradingState=ON`: call TS client to place the order and persist `LiveOrder(clobOrderId, status=...)`.

### 5.3 Tests (live executor)

6) Add vitest coverage for:
   - Tick rounding behavior (edge cases around exact tick boundaries)
   - Size rounding never exceeds target
   - Min size skip behavior
   - SHADOW mode never calls the TS client (mock)
   - Idempotency: same idempotencyKey does not place twice

7) Run: `pnpm -C apps/worker test`

---

## Phase 6 — User Channel WS + fills → DB + ledger (LIVE)

### 6.1 Implement authenticated User Channel WS client

1) Add `apps/worker/src/clob-ws/ClobUserWsClient.ts`
   - Connect/auth using the official TS client flow
   - Subscribe to user updates (orders + trades)
   - Reconnect with backoff; re-subscribe on reconnect
   - Expose health stats: connected, lastMessageAt, lastError

2) Persist order lifecycle updates
   - On order update messages:
     - upsert `LiveOrder` by `clobOrderId` (and/or `idempotencyKey` if provided)
     - update status timestamps

3) Persist fills/trades
   - On trade/fill messages:
     - upsert `LiveFill` by `tradeId`
     - link to `LiveOrder` if order id matches; else mark `origin=EXTERNAL`

### 6.2 Create LIVE ledger entries from fills

4) For each `LiveFill`:
   - Write `LedgerEntry(tradingMode=LIVE, entryType=TRADE_FILL, refId=live:trade:<tradeId>)`
   - Compute deltas from side:
     - BUY: `shareDelta=+size`, `cashDelta=-(price*size) - fee`
     - SELL: `shareDelta=-size`, `cashDelta=+(price*size) - fee`
   - Attribution:
     - If linked to a `LiveOrder`/`CopyAttempt`, set `followedUserId` from the `CopyAttempt`
     - If EXTERNAL, set `followedUserId=null` and keep `origin=EXTERNAL` on the fill

5) Update `CopyAttempt(tradingMode=LIVE)` fill metrics as fills arrive (optional but recommended)
   - Keep `filledNotionalMicros`, `filledRatioBps`, and `vwapPriceMicros` approximately current for UI parity.

### 6.3 Tests (WS ingestion)

6) Add fixture-based tests for message parsing + persistence:
   - Order update → LiveOrder status update
   - Fill update linked to known order → origin APP, ledger written with attribution
   - Fill update with unknown order → origin EXTERNAL, ledger written without attribution

7) Run: `pnpm -C apps/worker test`

---

## Phase 7 — Real Portfolio (exchange-based) + reconciliation

### 7.1 Fetch and persist exchange positions (authoritative)

1) Implement `apps/worker/src/live/positions.ts`
   - Use TS client to fetch:
     - current token positions (tokenId → shares)
     - USDC/collateral balance (if available)
   - Persist minute-bucketed snapshots:
     - `PortfolioSnapshot(tradingMode=LIVE, portfolioScope=EXEC_GLOBAL, followedUserId=null, bucketTime=...)`
     - `LivePositionSnapshot(bucketTime, tokenId, shareMicros, ...)`

2) Start a loop alongside existing snapshot loops
   - Update `apps/worker/src/snapshot/index.ts` to start/stop this live snapshot loop.

### 7.2 Reconcile ledger vs exchange positions (bug detector)

3) Implement reconciliation:
   - Compute ledger-projected position per token from `LedgerEntry(tradingMode=LIVE)`
   - Compare to exchange position snapshot
   - Persist diffs (`LivePositionDiffSnapshot`) and surface the latest diff status in the UI

### 7.3 Tests (snapshots + diffs)

4) Add tests for:
   - Snapshot bucketing correctness
   - Diff computation (ledger vs exchange)

5) Run: `pnpm -C apps/worker test`

---

## Phase 8 — Web: routes, pages, and APIs

### 8.1 Rename existing pages (Paper)

1) Create `apps/web/src/app/paper-trades/page.tsx`
   - Copy from `apps/web/src/app/copy-attempts/page.tsx`
   - Change labels to “Paper Trades”
   - Call the same endpoint but with `tradingMode=PAPER` (after API changes)

2) Convert `apps/web/src/app/copy-attempts/page.tsx` to a redirect to `/paper-trades`

3) Create `apps/web/src/app/paper-portfolio/page.tsx`
   - Copy from `apps/web/src/app/portfolio/page.tsx`
   - Update labels to “Paper Portfolio”
   - Use a paper portfolio endpoint (see below)

4) Convert `apps/web/src/app/portfolio/page.tsx` to a redirect to `/paper-portfolio`

### 8.2 Live Trades page

5) Add `apps/web/src/app/live-trades/page.tsx`
   - Status panel:
     - `liveTradingState`, `paperTradingEnabled`
     - user channel WS status + market channel WS status
     - last order time + last error
   - Tables:
     - Live Orders (from `LiveOrder`)
     - Live Fills/Trades (from `LiveFill`, include origin badge APP/EXTERNAL)
     - Skipped/Rejected (from `CopyAttempt(tradingMode=LIVE)`)
     - Positions snapshot (from `LivePositionSnapshot` + latest prices)
   - Kill switches:
     - set global `liveTradingState`
     - set per-user `liveOverride`

### 8.3 Real Portfolio page

6) Add `apps/web/src/app/real-portfolio/page.tsx`
   - Metrics from `PortfolioSnapshot(tradingMode=LIVE, EXEC_GLOBAL, null)`
   - Positions from `LivePositionSnapshot` (latest bucket)
   - Display:
     - “Authoritative source: Polymarket positions”
     - last reconciliation time + diff summary

### 8.4 Navigation

7) Update `apps/web/src/components/nav-items.ts`
   - Replace:
     - `/portfolio` → `/paper-portfolio`
     - `/copy-attempts` → `/paper-trades`
   - Add:
     - `/live-trades`
     - `/real-portfolio`

### 8.5 Web API endpoints

8) Update `apps/web/src/app/api/copy-attempts/route.ts`
   - Accept `tradingMode=PAPER|LIVE` and filter accordingly
   - For PAPER: keep fills join via `ExecutableFill`
   - For LIVE: include basic CopyAttempt fields; live fills come from separate endpoints

9) Add Live endpoints
   - `apps/web/src/app/api/live/orders/route.ts` (list + pagination)
   - `apps/web/src/app/api/live/fills/route.ts` (list + pagination, origin filter)
   - (no secrets in web) all portfolio data must come from DB snapshots written by the worker

10) Split portfolio endpoints cleanly
   - Keep existing `/api/portfolio/global` but make it explicitly PAPER:
     - filter `PortfolioSnapshot` + `LedgerEntry` by `tradingMode=PAPER`
   - Add `/api/portfolio/real` for the exchange-based Real Portfolio.

11) Add control endpoints
   - Global toggles:
     - `POST /api/control/trading` → set `{ copyEngineEnabled, liveTradingState }` in `system:config`
   - Per-user override:
     - `POST /api/users/live-override` → set `{ id, liveOverride }`

12) Update the Followed Users UI for live override (in addition to kill switches on Live Trades)
   - Update `apps/web/src/components/users-table.tsx` to show the current `liveOverride` and allow editing it (dropdown: INHERIT / FORCE_ON / FORCE_OFF).
   - Ensure the UI calls `POST /api/users/live-override` and uses SWR optimistic updates similar to the existing enable toggle.

### 8.6 Tests (web)

13) Run: `pnpm -C apps/web typecheck`, `pnpm -C apps/web lint`
14) Smoke test locally (manual):
   - Navigate all four pages and ensure they render without crashing on empty LIVE tables.

---

## Phase 9 — End-to-end validation checklist (must pass)

### 9.1 Paper regression
- With `liveTradingState=OFF`, paper trading behaves exactly as before:
  - Copy attempts still appear (now under Paper Trades)
  - Paper Portfolio matches previous numbers

### 9.2 Live shadow mode
- Set `liveTradingState=SHADOW`
  - Live Trades shows new `CopyAttempt(LIVE)` + `LiveOrder(SHADOW_ONLY)` records
  - No authenticated order placement calls are made

### 9.3 Live on (small, controlled)
- Set `liveTradingState=ON`
  - A new eligible leader trade produces a `LiveOrder` with a `clobOrderId`
  - User WS ingests order updates + fills
  - `LiveFill(origin=APP)` rows appear and ledger entries are written

### 9.4 External trade detection
- Make a manual trade on the same wallet outside the app
  - It appears as `LiveFill(origin=EXTERNAL)`
  - Real Portfolio positions reflect it (exchange snapshot)
  - UI clearly labels it as external

### 9.5 Reconciliation
- Ledger vs exchange diff is computed and visible
  - Ideally diff ~0 for APP trades
  - Non-zero diffs are persisted and highlighted as a bug signal

---

## Phase 10 — Deployment notes (don’t skip)

1) Update docker env wiring (`docker/docker-compose.yml`) to include the required live trading secrets as runtime env vars or Docker secrets.
2) Ensure logs never print secrets; review logging fields in:
   - `apps/worker/src/live/*`
   - WS clients
3) Ensure migrations are applied on deploy:
   - `pnpm prisma:migrate` (or `npx prisma migrate deploy` in container)
