Below is the **v0 “single source of truth” implementation plan** with *every decision locked* (no open choices left). If you build exactly what’s written here, you’ll get:

- Shadow portfolio **per followed user**
- Executable portfolio **per followed user**
- **Global executable** portfolio for you (combined copy trades)
- Dashboard with metrics/graphs
- Event-driven ingestion, rate-limited API usage, and fault tolerance
- Paper-trading only (no real orders), but security boundaries set up so v1 live trading can be added safely

---

# 0) Scope (v0)

## v0 goals
1) Detect followed users’ **BUY/SELL fills** and also **MERGE/SPLIT** events (when present in the activity feed).
2) Maintain:
   - **Shadow(User)** portfolio: exact replica of followed user fills/events
   - **Executable(User)** portfolio: simulated copy-trading of that user with guardrails + partial fills
   - **Global Executable** portfolio: simulated portfolio if you copy all enabled users together
3) Dashboard:
   - Equity curves
   - Win/loss + PnL
   - Attempt rate, fill rate, partial fill rate
   - Slippage + detection lag
   - Skip reasons (with reason codes)
   - Exposure by market/user
4) Must run on a **single DigitalOcean $12 droplet** (1 vCPU / 2GB RAM class) by staying event-driven and using snapshots (no heavy recomputation on page load).

## v0 non-goals
- No real trading / no signing / no custody.
- No mobile app.
- No multi-tenant / multiple admins. **Single admin** account only.
- No high-frequency market-data streaming to the UI (UI uses polling).

---

# 1) Stack (locked)

## Runtime + services
- **Docker Compose** on a single DigitalOcean droplet
- **Postgres** (Docker, named volume)
- **Redis** (Docker) for BullMQ queues
- **nginx** (Docker) as reverse proxy + TLS termination
- **Worker**: Node.js + TypeScript (Docker) — the bot
- **Web**: Next.js (Docker) dashboard
- **DB ORM**: Prisma
- **UI**: Tailwind CSS + shadcn/ui
- **Charts**: Recharts (used via shadcn chart patterns)
- **Auth**: NextAuth (OAuth). **GitHub provider required**, Google optional but supported.

## Data sources (locked)
- Canonical fills/events: **Polymarket Data API** (trades + activity)
- Low-latency trigger + verification: **Alchemy WebSocket logs subscription** to relevant on-chain fill events (narrow filter by contract addresses + topics)
- Mark-to-market pricing: Polymarket CLOB price endpoints (batched where possible)

---

# 2) Deployment topology (locked)

## Docker Compose services (exact)
- `db` (postgres:16)
- `redis` (redis:7)
- `worker` (node:20-alpine)
- `web` (node:20-alpine, Next.js standalone build)
- `nginx` (nginx:stable-alpine)
- `certbot` (optional container OR host-installed; v0 uses host-installed certbot is acceptable)

## Networking rules (exact)
- Publicly exposed:
  - `80/tcp`, `443/tcp` to nginx
  - `22/tcp` SSH (restricted by firewall to your IPs if possible)
- Not exposed publicly:
  - Postgres, Redis (Docker internal network only)

## Process resilience (exact)
- All containers: `restart: always`
- Health checks:
  - `web`: HTTP `/api/health`
  - `worker`: HTTP `/health` (worker hosts a minimal HTTP server on internal network)
  - `db`: postgres readiness
  - `redis`: `PING`

---

# 3) Repo layout (locked)

Monorepo:

```
/apps
  /web            (Next.js + shadcn + Tailwind + Recharts)
  /worker         (TS worker + BullMQ processors)
/packages
  /shared         (shared types, config schema, reason codes)
/prisma
  schema.prisma
/docker
  nginx.conf
  docker-compose.yml
  Dockerfile.web
  Dockerfile.worker
```

Shared types are the contract between worker + web.

---

# 4) Core data model (Prisma schema requirements)

## Storage rules (exact)
- All monetary quantities stored as **integers**:
  - `usdc_amount_micros` (USDC 6 decimals → integer “micros”)
  - `price_micros` for probability prices (store price 0..1 as 0..1_000_000)
  - shares can be stored as `share_micros` if fractional, otherwise integer shares (v0 stores `share_micros` to be safe)
- No floats in DB.
- Immutable event tables; portfolio is derived from append-only ledger entries + snapshots.

## Entities (exact)
You will implement these tables/models (names locked). The exact Prisma field details can be adjusted, but the keys/constraints must hold.

### 4.1 Followed users + config
- `FollowedUser`
  - `id` (uuid)
  - `label` (string)
  - `profileWallet` (string, unique)
  - `enabled` (bool)
  - `createdAt`
- `FollowedUserProxyWallet`
  - `id`
  - `followedUserId`
  - `wallet` (string, unique)
- `GuardrailConfig`
  - one row for global config (`scope = GLOBAL`)
  - optional per-user override row (`scope = USER`, `followedUserId`)
  - JSON fields allowed, but **final evaluated config must be materialized by worker** (don’t compute merging logic ad-hoc in UI)
- `CopySizingConfig`
  - global + per-user override
  - includes copy percent, min/max trade caps

### 4.2 Market reference
- `Market`
  - `id` (string, unique; Polymarket market id)
  - `conditionId` (string, indexed)
  - `resolvedAt` (datetime nullable)
  - `closeTime` (datetime nullable)
  - `active` (bool)
- `OutcomeAsset`
  - `id` (string, unique; asset id)
  - `marketId`
  - `outcome` (“YES”/“NO” or outcome label)

### 4.3 Canonical events (immutable)
- `TradeEvent`
  - One row per normalized fill event (BUY/SELL)
  - Unique constraint: `source + sourceId` **OR** `txHash + logIndex` for on-chain
  - Fields: user wallet, proxy wallet, market/asset, side, price_micros, share_micros, usdc_notional_micros, fees_micros (if known), eventTime, detectTime
- `ActivityEvent`
  - For merge/split (and optionally redeem) events from activity feed
  - Unique constraint: `source + sourceId`
  - Fields: type (MERGE/SPLIT/REDEEM), asset ids involved, amounts, eventTime, detectTime

### 4.4 Copy decisions + simulated fills
- `CopyAttempt`
  - One row per “attempt to copy” per event-group (aggregation window)
  - Unique constraint: `portfolioScope + followedUserId + groupKey`
  - Fields:
    - `portfolioScope` = USER_EXECUTABLE or GLOBAL_EXECUTABLE
    - target_notional_micros
    - decision: EXECUTE / SKIP
    - reasonCodes: string[] (must be non-empty when SKIP)
    - their_reference_price_micros
    - mid_price_micros_at_decision
    - createdAt
- `ExecutableFill`
  - One row per simulated fill level consumed (L2 book levels)
  - Links to CopyAttempt
  - Fields: filled_share_micros, fill_price_micros, fill_notional_micros, vwap_price_micros (also stored on CopyAttempt as aggregate)

### 4.5 Ledgers (append-only)
- `LedgerEntry`
  - `portfolioScope` (SHADOW_USER / EXEC_USER / EXEC_GLOBAL)
  - `followedUserId` nullable for global
  - `marketId`, `assetId`
  - `entryType`: TRADE_FILL / MERGE / SPLIT / FEE / MARK / SETTLEMENT
  - `share_delta_micros`, `cash_delta_micros`
  - `price_micros` (when applicable)
  - `refId` (TradeEvent/ActivityEvent/CopyAttempt)
  - Unique constraint to prevent duplicates per refId + scope

### 4.6 Snapshots (for charts)
- `PortfolioSnapshot`
  - `portfolioScope`
  - `followedUserId` nullable for global
  - timestamp (bucketed to minute)
  - equity_micros, cash_micros, exposure_micros, unrealized_pnl_micros, realized_pnl_micros
- `MarketPriceSnapshot`
  - assetId, timestamp bucket
  - midpoint_price_micros (or last price fallback)
- `SystemCheckpoint`
  - last processed block (alchemy) and last processed API cursor/time per user
  - used for backfill + restart

---

# 5) Copy semantics (locked)

## 5.1 What we copy
- Copy **BUYS, SELLS, MERGES, SPLITS** “when applicable”.
- “Merge and split when applicable” means:
  - Shadow(User): always apply them exactly as reported
  - Executable(User/Global): attempt to perform same action **only if** executable portfolio has required positions/collateral; otherwise SKIP with reason code.

## 5.2 How we size (locked)
- **Scale by notional**
- Default per event-group:
  - `their_notional_micros = their_price_micros * their_share_micros / 1_000_000`
  - `target_notional_micros = floor(their_notional_micros * 0.01)`
- Clamp target notional (global default):
  - `MIN_TRADE_NOTIONAL = 5 USDC`
  - `MAX_TRADE_NOTIONAL = min(250 USDC, 0.75% of current bankroll equity)`
- For SELL:
  - target based on their sell notional
  - also capped by your current position (cannot sell more than you hold)

Per-user overrides can change:
- `copy_pct_notional` (default 1%)
- per-user max trade notional

## 5.3 Aggregation window (locked)
To avoid treating many tiny fills as separate copy orders:
- Group fills by `(followedUserId, assetId, side)` within:
  - `AGGREGATION_WINDOW_MS = 2000`
- CopyAttempt is created per group (not per individual fill).

## 5.4 Allocation when multiple users fire (locked)
Global executable portfolio processes groups in **FIFO by detect time**.  
If risk caps block later trades, they are skipped with reason `RISK_CAP_GLOBAL`.

---

# 6) Default guardrails (locked defaults, configurable globally + per user)

All guardrails exist in:
- Global config (applies to all)
- Optional per-user override (overrides global)

### 6.1 Price protection
Two checks apply; **both must pass**.

1) **Worsening vs their fill**
- BUY: `your_vwap_price_micros <= their_price_micros + 10_000` (=$0.01)
- SELL: `your_vwap_price_micros >= their_price_micros - 10_000`

2) **Chase protection vs mid at decision**
- BUY: `your_vwap_price_micros <= mid_price_micros + 15_000` (=$0.015)
- SELL: `your_vwap_price_micros >= mid_price_micros - 15_000`

### 6.2 Spread filter
- `spread_abs = bestAsk - bestBid`
- Skip if `spread_abs > 20_000` (=$0.02)

### 6.3 Depth requirement inside allowed band
Compute available notional within acceptable band:
- BUY: asks up to `max_acceptable_price`
- SELL: bids down to `min_acceptable_price`

Require:
- `available_notional_micros >= 1.25 * target_notional_micros`

### 6.4 Partial fills (locked)
- Partial fills are **allowed**
- If filled ratio `< 100%`, record filled ratio and proceed.
- If filled ratio `= 0%`, treat as SKIP with `NO_LIQUIDITY_WITHIN_BOUNDS`.

### 6.5 Timing realism (locked)
Executable simulation uses an artificial delay:
- `DECISION_LATENCY_MS = 750`
- `JITTER_MS = uniform(0..250)` (optional but enabled by default)

### 6.6 Market lifecycle
- Do **not** open new positions when `time_to_close < 30 minutes`
- Allow closes/reductions anytime

### 6.7 Risk limits (global defaults)
- `MAX_TOTAL_EXPOSURE = 70%` of equity
- `MAX_EXPOSURE_PER_MARKET = 5%` of equity
- `MAX_EXPOSURE_PER_USER = 20%` of equity
- Circuit breakers:
  - `DAILY_LOSS_LIMIT = 3%`
  - `WEEKLY_LOSS_LIMIT = 8%`
  - `MAX_DRAWDOWN_LIMIT = 12%`
When tripped: **no new opens**, reductions allowed.

---

# 7) Pricing + PnL rules (locked)

## Mark-to-market price
- Preferred: midpoint price (bestBid+bestAsk)/2 from Polymarket price endpoints
- Fallback: last trade price (if midpoint unavailable)
- Store in `MarketPriceSnapshot` every **30 seconds** for assets currently held in any portfolio.

## Equity computation
For each portfolio:
- `equity = cash + Σ(position_shares * mark_price)`
- Positions stored per `assetId`.

## Realized vs unrealized
- Realized PnL computed from ledger fill events using average cost per asset.
- Unrealized from current mark vs average cost.

---

# 8) Ingestion architecture (worker) (locked)

The worker is event-driven and designed for disconnections/restarts.

## 8.1 Queues (BullMQ) (exact)
Queues:
- `q_ingest_events` (new trade/activity events)
- `q_group_events` (aggregation into groups)
- `q_copy_attempt_user` (simulate executable per-user)
- `q_copy_attempt_global` (simulate global)
- `q_portfolio_apply` (write ledger entries + update snapshots)
- `q_reconcile` (periodic backfill + sanity checks)
- `q_prices` (periodic mark-to-market refresh for held assets)

Retries:
- 3 retries with exponential backoff + jitter on network errors
- 429 triggers slower backoff and opens circuit breaker

DLQ:
- Any job failing after retries goes to DLQ with payload + error.

## 8.2 Rate limiting (exact)
All outbound calls go through token-bucket limiters.

- **Alchemy**:
  - One WS connection
  - One logs subscription (narrow)
  - No periodic RPC polling
  - Any fallback RPC calls limited (hard cap) to stay below free-tier CU/s comfortably

- **Polymarket**:
  - Trades/activity polling per user: every **30 seconds**
  - Backfill on startup/reconnect: last **15 minutes**
  - Order book `/book` calls: **only** when copying a group (event-driven)
  - Price refresh: every **30 seconds** but only for held assets

Limiter parameters (safe defaults):
- `POLYMARKET_MAX_RPS = 20`
- `POLYMARKET_BURST = 40`
- `ALCHEMY_FALLBACK_MAX_RPS = 5` (should almost never be used)

## 8.3 Idempotency (exact)
- Every `TradeEvent` and `ActivityEvent` insert is upserted with unique key.
- Every ledger write is guarded by `(scope, refId, entryType)` uniqueness.
- CopyAttempt is keyed by `(scope, followedUserId, groupKey)`.

This guarantees restarts/retries do not duplicate state.

## 8.4 Backfill + restart behavior (exact)
On worker startup:
1) Load checkpoints
2) Start Alchemy WS subscription
3) Immediately backfill last 15 minutes for each followed user from Data API (trades + activity)
4) Reconcile: ensure newest API events are in DB, then resume live flow

On WS disconnect:
- reconnect with exponential backoff
- on reconnect: backfill last 5 minutes and reconcile

Periodic reconciler:
- every 60 seconds:
  - backfill last 2 minutes
  - validate worker is making forward progress (last event time advances)
  - if stuck: emit alert log + keep retrying

---

# 9) Worker business logic (exact step-by-step)

For each new canonical event (trade fill or merge/split):

## Step A: Normalize
Convert raw API/on-chain payload into canonical:
- assetId
- marketId
- side/type
- price_micros (trades only)
- share_micros (trades only)
- notional_micros
- eventTime + detectTime
- wallet mapping (profile + proxy)

## Step B: Apply to Shadow(User)
- Write `LedgerEntry` to `SHADOW_USER` scope:
  - Trades: shares/cash deltas at exact fill price
  - Merge/Split: deterministic token conversions based on event payload
- Update `PortfolioSnapshot` (bucketed to minute) via incremental update job

## Step C: Aggregate for executable
Place event into aggregation buffer keyed by `(followedUserId, assetId, side/type)`:
- flush every 2 seconds or when window elapses
- create `EventGroup` (internal object; persisted via CopyAttempt key)

## Step D: Per-user executable simulation
For each flushed group:
1) Compute `target_notional` (1% * their_group_notional), clamp
2) Apply user executable risk caps
3) Fetch L2 order book once at `decision_time = now + latency + jitter`
4) Simulate fills across levels **until**:
   - filled target shares OR
   - price protection violated OR
   - liquidity ends
5) Record CopyAttempt + ExecutableFill rows
6) Write executable ledger entries for `EXEC_USER` scope

## Step E: Global executable simulation
Same group also submitted to global queue:
- FIFO by detect time
- Apply global risk caps (and global cash constraints)
- Simulate with same book snapshot approach
- Write ledger entries to `EXEC_GLOBAL` scope

---

# 10) Dashboard (Next.js) pages (locked)

UI uses shadcn + Tailwind. Charts use Recharts. UI polls server APIs.

## Polling cadence (exact)
- Overview summary: every **10 seconds**
- Trades/copy attempts feed: every **5 seconds**
- System status: every **10 seconds**
- Heavy pages (markets list): manual refresh or 30 seconds

## Pages (exact)
1) **Overview**
   - Global executable equity curve
   - Today/7D PnL, drawdown, win rate
   - Exposure summary
   - Top markets, top users
   - System health (WS, backfill, lag p95)
   - Global pause/resume toggle (paper “copy engine enabled”)

2) **Followed Users**
   - table with shadow vs executable metrics
   - enable/disable per user
   - link to user detail

3) **User Detail**
   - Shadow vs Executable equity curves overlay
   - Tracking gap chart
   - Attempt rate / fill rate / partial fill rate
   - Slippage distribution
   - Detect lag distribution
   - Skip reason histogram
   - Positions (shadow + exec)
   - Trade feed + copy attempt outcomes

4) **Global Portfolio**
   - open positions
   - exposure breakdown by market and by user
   - drawdown + risk utilization

5) **Trades & Copy Attempts**
   - tab: Detected Trades (their fills)
   - tab: Copy Attempts (execute/skip + reason codes)
   - filters by user/market/decision/reason

6) **Markets**
   - list + detail:
     - liquidity stats (spread, depth in band)
     - your slippage history
     - open positions
     - optional market blacklist toggle (stored in DB; worker respects)

7) **Config**
   - global guardrails + sizing + risk limits
   - per-user overrides editor
   - “Test config” button:
     - runs evaluation on last 24h of events (server-side) and shows how many would be executed vs skipped

8) **System Status**
   - queue depths, DLQ count
   - last processed event time
   - last backfill time
   - API error rates
   - DB size, snapshot freshness

## API routes (exact)
- `GET /api/health`
- `GET /api/overview`
- `GET /api/users`
- `GET /api/users/:id`
- `GET /api/portfolio/global`
- `GET /api/trades`
- `GET /api/copy-attempts`
- `GET /api/markets`
- `POST /api/config/global`
- `POST /api/config/user/:id`
- `POST /api/control/pause` (toggles “copy engine enabled” flag in DB; worker reads it)

All API routes are server-only, Prisma-backed, and require NextAuth session.

---

# 11) Security boundaries (v0 built like v1)

## Hard boundary (exact)
- **Only the worker** may ever hold trading credentials in v1.
- The web dashboard never gets secrets, never signs anything.
- v0 includes the architecture boundary now:
  - web writes config/control intents to DB
  - worker consumes and acts

## v0 secrets (exact)
- DB password
- Redis password (optional on internal-only; still recommended)
- NextAuth secret
- OAuth client secrets
- Alchemy key
- Polymarket API base URL + any API key if needed

Storage:
- `.env` files are not committed
- use droplet environment or docker-compose env files with strict permissions

## Web hardening (exact)
- NextAuth session via HttpOnly secure cookies
- Strict CORS: same-origin only
- Rate limit auth endpoints at nginx level
- Input validation with Zod on all write endpoints
- Audit log (table) for config changes, enable/disable user, pause/resume

## Supply chain (exact)
- `pnpm` with lockfile committed
- dependency versions pinned
- CI runs:
  - typecheck
  - lint
  - `pnpm audit` (or equivalent)

---

# 12) Fault tolerance + recovery (exact)

## Self-healing rules
- Docker restart always
- Worker is stateless aside from DB/Redis
- Any failure must be recoverable by replay:
  - canonical events are immutable
  - ledger is idempotent
  - snapshots can be recomputed from ledger if needed

## Runbooks (must exist in repo)
- “How to redeploy”
- “How to restore DB from backup”
- “How to backfill last X hours”
- “How to clear stuck jobs safely”

---

# 13) Backups (exact)

- Nightly `pg_dump` to a compressed file
- Keep last 7 daily backups
- Store backups off-droplet (DO Spaces or another host) — encryption recommended
- Test restore procedure once before calling v0 “done”

Redis persistence:
- Not relied on for truth; queue can be rebuilt
- Still configure AOF (`appendonly yes`) to reduce job loss on reboot

---

# 14) Acceptance criteria (v0 is “done” only if all pass)

## Data correctness
- Shadow(User) matches detected events exactly (spot-check 50 events)
- Executable(User) produces CopyAttempt rows with correct sizing + reason codes
- Global executable respects caps and FIFO ordering

## Reliability
- Kill the worker container → it restarts and backfills without duplicates
- Drop WS connection → reconnect + backfill restores continuity
- Induce a 429 from API (simulate) → rate limiter backs off; system recovers

## Dashboard
- Every page loads in <2s on droplet for normal dataset
- Charts render from snapshots (not heavy recompute)
- You can see:
  - equity curves
  - trades + copy attempts
  - skip reasons and slippage
  - exposure by market and user

---

# 15) Implementation order (exact milestone sequence)

1) **Infra + repo scaffolding**
   - monorepo, docker compose, nginx, postgres, redis, basic web + worker containers

2) **Prisma schema + migrations**
   - all tables + constraints + indexes
   - seed single admin + empty followed users

3) **Worker ingestion**
   - Polymarket API polling (trades + activity)
   - insert canonical events idempotently
   - shadow ledger updates

4) **Aggregation + executable simulation**
   - group window logic
   - book fetch
   - partial fill simulation
   - CopyAttempt + ExecutableFill writes
   - exec ledgers (per-user + global)

5) **Snapshots + prices**
   - mark-to-market refresh loop
   - portfolio snapshots written every minute

6) **Dashboard**
   - NextAuth
   - pages listed above
   - polling endpoints

7) **Resilience**
   - WS trigger + reconnect
   - backfill on startup/reconnect
   - DLQ + status page

8) **Backup + runbooks**
   - automated backups
   - documented restore/backfill procedures
