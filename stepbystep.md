Below is a **no-ambiguity, end-to-end, step-by-step implementation guide** for v0 that produces a final product matching **planning.md** exactly.

I’m going to assume:
- You’re using **GitHub** for source control
- You’ll deploy to a **single DigitalOcean $12 droplet**
- You have (or will buy) a domain for HTTPS (recommended). If you don’t, you can still run it with IP + self-signed cert, but the guide uses Let’s Encrypt.

---

# Phase 0 — Prep (accounts, keys, domain)

## 0.1 Create required accounts
You need:
1) **Alchemy** account + an app for the target chain
2) **Polymarket** API access (public endpoints for data; no trading keys for v0)
3) **GitHub OAuth App** for NextAuth

## 0.2 Create and record secrets (do this now)
Create a password manager entry with these exact fields:

### Core
- `DOMAIN` = `yourdomain.com`
- `ADMIN_EMAIL` = your email used in GitHub (the only allowed admin)
- `NEXTAUTH_SECRET` = 32+ bytes random
- `POSTGRES_PASSWORD` = strong random
- `REDIS_PASSWORD` = strong random
- `ALCHEMY_WS_URL` = Alchemy websocket URL
- `POLYMARKET_DATA_API_BASE_URL` = base URL for Polymarket Data API
- `POLYMARKET_CLOB_BASE_URL` = base URL for Polymarket CLOB API

### GitHub OAuth (NextAuth)
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

> v0 has **no trading keys**. Don’t add them.

---

# Phase 1 — Repo scaffolding (monorepo + tooling)

## 1.1 Create the repo structure
On your dev machine:

```bash
mkdir polymarketspy
cd polymarketspy
git init
```

Create this folder layout:

```bash
mkdir -p apps/web apps/worker packages/shared prisma docker
```

## 1.2 Use pnpm workspaces (locked decision)
Create `package.json` at repo root:

```json
{
  "name": "polymarketspy",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "pnpm -r dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate deploy",
    "prisma:studio": "prisma studio"
  },
  "devDependencies": {
    "prisma": "^5.0.0",
    "typescript": "^5.5.0"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create a root `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

Commit now:

```bash
git add .
git commit -m "chore: init monorepo scaffolding"
```

---

# Phase 2 — Prisma + Postgres schema (source of truth DB)

## 2.1 Create Prisma schema file
Create `prisma/schema.prisma`.

**Important:** The plan states model names are locked; fields can be adjusted but must preserve constraints and semantics. Use this as your starting point (includes the required unique constraints and core fields).

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum ConfigScope {
  GLOBAL
  USER
}

enum TradeSide {
  BUY
  SELL
}

enum ActivityType {
  MERGE
  SPLIT
  REDEEM
}

enum PortfolioScope {
  SHADOW_USER
  EXEC_USER
  EXEC_GLOBAL
}

enum CopyDecision {
  EXECUTE
  SKIP
}

enum LedgerEntryType {
  TRADE_FILL
  MERGE
  SPLIT
  FEE
  MARK
  SETTLEMENT
}

model FollowedUser {
  id            String   @id @default(uuid())
  label         String
  profileWallet String   @unique
  enabled       Boolean  @default(true)
  createdAt     DateTime @default(now())
  proxies       FollowedUserProxyWallet[]
  guardrails    GuardrailConfig[]
  sizing        CopySizingConfig[]
}

model FollowedUserProxyWallet {
  id            String @id @default(uuid())
  followedUserId String
  wallet        String @unique

  followedUser  FollowedUser @relation(fields: [followedUserId], references: [id], onDelete: Cascade)

  @@index([followedUserId])
}

model GuardrailConfig {
  id            String      @id @default(uuid())
  scope         ConfigScope
  followedUserId String?
  // stored as JSON; worker materializes effective config
  configJson     Json
  updatedAt      DateTime @updatedAt

  followedUser   FollowedUser? @relation(fields: [followedUserId], references: [id], onDelete: Cascade)

  @@index([scope])
  @@index([followedUserId])
}

model CopySizingConfig {
  id            String      @id @default(uuid())
  scope         ConfigScope
  followedUserId String?
  configJson     Json
  updatedAt      DateTime @updatedAt

  followedUser   FollowedUser? @relation(fields: [followedUserId], references: [id], onDelete: Cascade)

  @@index([scope])
  @@index([followedUserId])
}

model Market {
  id          String   @id // Polymarket market id
  conditionId String
  resolvedAt  DateTime?
  closeTime   DateTime?
  active      Boolean  @default(true)

  assets      OutcomeAsset[]

  @@index([conditionId])
  @@index([closeTime])
}

model OutcomeAsset {
  id       String @id // asset id
  marketId String
  outcome  String

  market   Market @relation(fields: [marketId], references: [id], onDelete: Cascade)

  @@index([marketId])
}

model TradeEvent {
  id                   String   @id @default(uuid())
  // source can be POLYMARKET_API or ALCHEMY
  source               String
  sourceId             String?
  txHash               String?
  logIndex             Int?
  isCanonical          Boolean  @default(false)

  profileWallet        String
  proxyWallet          String?

  marketId             String?
  assetId              String?

  side                 TradeSide
  priceMicros          Int      // 0..1_000_000
  shareMicros          BigInt
  notionalMicros       BigInt
  feeMicros            BigInt?

  eventTime            DateTime
  detectTime           DateTime

  createdAt            DateTime @default(now())

  @@index([profileWallet, eventTime])
  @@index([proxyWallet, eventTime])
  @@index([assetId, eventTime])
  @@unique([source, sourceId])
  @@unique([txHash, logIndex])
}

model ActivityEvent {
  id             String   @id @default(uuid())
  source         String
  sourceId       String
  isCanonical    Boolean  @default(false)

  profileWallet  String
  proxyWallet    String?

  type           ActivityType
  // store involved asset ids and amounts in JSON
  payloadJson    Json

  eventTime      DateTime
  detectTime     DateTime

  createdAt      DateTime @default(now())

  @@index([profileWallet, eventTime])
  @@unique([source, sourceId])
}

model CopyAttempt {
  id                      String      @id @default(uuid())
  portfolioScope          PortfolioScope
  followedUserId          String?
  groupKey                String      // deterministic key for aggregation group

  decision                CopyDecision
  reasonCodes             String[]    // non-empty when SKIP

  targetNotionalMicros    BigInt
  filledNotionalMicros    BigInt      @default(0)
  vwapPriceMicros         Int?        // set when executed/partial
  filledRatioBps          Int         @default(0) // 0..10000

  theirReferencePriceMicros Int
  midPriceMicrosAtDecision Int

  createdAt               DateTime @default(now())

  followedUser            FollowedUser? @relation(fields: [followedUserId], references: [id], onDelete: Cascade)
  fills                   ExecutableFill[]

  @@index([portfolioScope, createdAt])
  @@index([followedUserId, createdAt])
  @@unique([portfolioScope, followedUserId, groupKey])
}

model ExecutableFill {
  id                String  @id @default(uuid())
  copyAttemptId     String
  filledShareMicros BigInt
  fillPriceMicros   Int
  fillNotionalMicros BigInt

  copyAttempt       CopyAttempt @relation(fields: [copyAttemptId], references: [id], onDelete: Cascade)

  @@index([copyAttemptId])
}

model LedgerEntry {
  id              String        @id @default(uuid())
  portfolioScope  PortfolioScope
  followedUserId  String?
  marketId        String?
  assetId         String?

  entryType       LedgerEntryType

  shareDeltaMicros BigInt
  cashDeltaMicros  BigInt
  priceMicros      Int?

  refId            String
  createdAt        DateTime @default(now())

  @@index([portfolioScope, createdAt])
  @@index([assetId, createdAt])
  @@unique([portfolioScope, refId, entryType])
}

model PortfolioSnapshot {
  id              String        @id @default(uuid())
  portfolioScope  PortfolioScope
  followedUserId  String?
  bucketTime      DateTime      // minute-bucketed timestamp

  equityMicros    BigInt
  cashMicros      BigInt
  exposureMicros  BigInt
  unrealizedPnlMicros BigInt
  realizedPnlMicros   BigInt

  @@index([portfolioScope, bucketTime])
  @@index([followedUserId, bucketTime])
  @@unique([portfolioScope, followedUserId, bucketTime])
}

model MarketPriceSnapshot {
  id             String   @id @default(uuid())
  assetId        String
  bucketTime     DateTime
  midpointPriceMicros Int

  @@index([assetId, bucketTime])
  @@unique([assetId, bucketTime])
}

model SystemCheckpoint {
  id            String   @id @default(uuid())
  key           String   @unique // e.g. "alchemy:lastBlock" or "api:lastTradeTime:<userId>"
  valueJson     Json
  updatedAt     DateTime @updatedAt
}

model AllowedAdminEmail {
  id        String   @id @default(uuid())
  email     String   @unique
  createdAt DateTime @default(now())
}
```

## 2.2 Create the database URL convention (locked)
`DATABASE_URL` must be in standard format:

```
postgresql://copybot:<PASSWORD>@db:5432/copybot?schema=public
```

## 2.3 Install Prisma client + dependencies
At repo root:

```bash
pnpm add -D prisma
pnpm add @prisma/client
```

Generate client:

```bash
pnpm prisma:generate
```

Commit:

```bash
git add prisma package.json pnpm-lock.yaml
git commit -m "db: add prisma schema and client"
```

---

# Phase 3 — Shared package (types + config schema + reason codes)

## 3.1 Create `packages/shared`
Create `packages/shared/package.json`:

```json
{
  "name": "@copybot/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "dev": "tsc -w --pretty false",
    "build": "tsc --pretty false",
    "lint": "echo ok",
    "typecheck": "tsc --noEmit"
  }
}
```

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src"]
}
```

Install Zod in root (shared usage):

```bash
pnpm add zod
```

## 3.2 Define *locked* reason codes
Create `packages/shared/src/reasonCodes.ts`:

```ts
export const ReasonCodes = {
  RISK_CAP_GLOBAL: "RISK_CAP_GLOBAL",
  RISK_CAP_USER: "RISK_CAP_USER",
  SPREAD_TOO_WIDE: "SPREAD_TOO_WIDE",
  INSUFFICIENT_DEPTH: "INSUFFICIENT_DEPTH",
  PRICE_WORSE_THAN_THEIR_FILL: "PRICE_WORSE_THAN_THEIR_FILL",
  PRICE_TOO_FAR_OVER_MID: "PRICE_TOO_FAR_OVER_MID",
  NO_LIQUIDITY_WITHIN_BOUNDS: "NO_LIQUIDITY_WITHIN_BOUNDS",
  MARKET_TOO_CLOSE_TO_CLOSE: "MARKET_TOO_CLOSE_TO_CLOSE",
  CIRCUIT_BREAKER_TRIPPED: "CIRCUIT_BREAKER_TRIPPED",
  NOT_ENOUGH_POSITION_TO_SELL: "NOT_ENOUGH_POSITION_TO_SELL",
  MERGE_SPLIT_NOT_APPLICABLE: "MERGE_SPLIT_NOT_APPLICABLE"
} as const;

export type ReasonCode = typeof ReasonCodes[keyof typeof ReasonCodes];
```

## 3.3 Define locked config schema (global + per-user override)
Create `packages/shared/src/config.ts`:

```ts
import { z } from "zod";

export const GuardrailsSchema = z.object({
  maxWorseningVsTheirFillMicros: z.number().int().default(10_000), // $0.01
  maxOverMidMicros: z.number().int().default(15_000), // $0.015
  maxSpreadMicros: z.number().int().default(20_000), // $0.02
  minDepthMultiplierBps: z.number().int().default(12_500), // 1.25x => 12500 bps
  noNewOpensWithinMinutesToClose: z.number().int().default(30),

  decisionLatencyMs: z.number().int().default(750),
  jitterMsMax: z.number().int().default(250),

  maxTotalExposureBps: z.number().int().default(7000),
  maxExposurePerMarketBps: z.number().int().default(500),
  maxExposurePerUserBps: z.number().int().default(2000),

  dailyLossLimitBps: z.number().int().default(300),
  weeklyLossLimitBps: z.number().int().default(800),
  maxDrawdownLimitBps: z.number().int().default(1200)
});

export type Guardrails = z.infer<typeof GuardrailsSchema>;

export const SizingSchema = z.object({
  copyPctNotionalBps: z.number().int().default(100), // 1% = 100 bps
  minTradeNotionalMicros: z.number().int().default(5_000_000), // 5 USDC
  maxTradeNotionalMicros: z.number().int().default(250_000_000), // 250 USDC
  maxTradeBankrollBps: z.number().int().default(75) // 0.75% = 75 bps
});

export type Sizing = z.infer<typeof SizingSchema>;
```

Export in `packages/shared/src/index.ts`:

```ts
export * from "./reasonCodes";
export * from "./config";
```

Commit:

```bash
git add packages/shared
git commit -m "shared: add reason codes and config schema"
```

---

# Phase 4 — Worker app (bot service)

## 4.1 Create worker package
Create `apps/worker/package.json`:

```json
{
  "name": "@copybot/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc --pretty false",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@copybot/shared": "workspace:*",
    "@prisma/client": "^5.0.0",
    "bullmq": "^5.0.0",
    "bottleneck": "^2.19.5",
    "ethers": "^6.0.0",
    "ioredis": "^5.0.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "undici": "^6.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

Create `apps/worker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Install dependencies:

```bash
pnpm install
```

## 4.2 Worker env vars (locked)
Worker requires these env vars:

- `DATABASE_URL`
- `REDIS_URL` (must include password; e.g. `redis://:pass@redis:6379`)
- `ALCHEMY_WS_URL`
- `POLYMARKET_DATA_API_BASE_URL`
- `POLYMARKET_CLOB_BASE_URL`

Also:
- `NODE_ENV=production`
- `LOG_LEVEL=info`

## 4.3 Worker architecture modules (locked)
Create these folders:

```bash
mkdir -p apps/worker/src/{db,log,queue,http,poly,alchemy,ingest,portfolio,simulate,reconcile,prices,health,config}
```

### 4.3.1 Logging
`apps/worker/src/log/logger.ts`:

- Use `pino`
- Always log JSON in production
- Include `service=worker`, `job`, `eventId`, `userId` when applicable

### 4.3.2 Prisma singleton
`apps/worker/src/db/prisma.ts` creates a single Prisma client.

### 4.3.3 Rate limiting (token bucket) — locked behavior
Use Bottleneck limiters:

- `polymarketLimiter`:
  - `minTime = 50ms` (≈20 rps)
  - `reservoir = 40`, refresh per second to 20 (burst 40)
- `alchemyFallbackLimiter`:
  - `minTime = 200ms` (5 rps)
  - (should be nearly unused)

All HTTP calls go through a wrapper that schedules via limiter.

### 4.3.4 Queues (BullMQ) — locked set
Define exactly these queues:
- `q_ingest_events`
- `q_group_events`
- `q_copy_attempt_user`
- `q_copy_attempt_global`
- `q_portfolio_apply`
- `q_reconcile`
- `q_prices`

Also define:
- retries: 3 attempts with exponential backoff + jitter
- DLQ: BullMQ “failed” state + a job that copies payloads to a `dead-letter` list/table OR at least logs loudly; v0 minimum is “show DLQ count in System Status”.

### 4.3.5 Health server
Worker must expose `GET /health` on an internal port (e.g., 8081).
Response includes:
- `status`
- `lastCanonicalEventTime`
- `wsConnected`
- `queueDepths`

## 4.4 Implement ingestion: Polymarket Data API polling (canonical)
This is canonical. It feeds Shadow and triggers executable.

### 4.4.1 Checkpoints
Use `SystemCheckpoint` keys:
- `api:lastTradeTime:<followedUserId>`
- `api:lastActivityTime:<followedUserId>`
Store ISO timestamps in JSON.

### 4.4.2 Polling schedule (locked)
- Every **30 seconds**, per enabled followed user:
  - fetch trades since last timestamp (or last 15 minutes on cold start)
  - fetch activity since last timestamp
- On startup:
  - backfill last **15 minutes**
- Reconcile job every **60 seconds**:
  - backfill last **2 minutes** regardless of checkpoint (safety net)

### 4.4.3 Idempotent upsert
When inserting canonical events:
- `TradeEvent.source = "POLYMARKET_API"`
- `TradeEvent.isCanonical = true`
- `TradeEvent.sourceId = <api trade id>`
- Upsert by unique `(source, sourceId)`
- Do **not** double-process: only enqueue to `q_ingest_events` if insert was new.

Similarly for activity:
- `ActivityEvent.source = "POLYMARKET_API"`
- `ActivityEvent.isCanonical = true`
- Upsert by `(source, sourceId)`

### 4.4.4 Proxy wallet discovery (locked)
From API trade/activity payloads:
- If a `proxyWallet` is present and not in DB:
  - insert into `FollowedUserProxyWallet` (idempotent unique on wallet)

## 4.5 Implement Alchemy WS logs (trigger + verification)
This is **not canonical**. It must not drive portfolios directly.

### 4.5.1 WS behavior
- One WS connection
- One logs subscription (narrow filter)
- On receiving an on-chain fill event:
  - insert `TradeEvent` with:
    - `source = "ALCHEMY"`
    - `isCanonical = false`
    - `txHash`, `logIndex`
    - `detectTime = now`
    - `eventTime = block timestamp` (if known; otherwise fill later)
  - immediately enqueue a **fast reconcile** for the affected window (or user if derivable) by pushing a job to `q_reconcile`

### 4.5.2 Checkpoint
Maintain `SystemCheckpoint` key:
- `alchemy:lastBlock`

### 4.5.3 WS reconnect & recovery (locked)
- On disconnect:
  - reconnect with exponential backoff
- On reconnect:
  - enqueue reconcile for last 5 minutes
- Never assume WS was perfect.

## 4.6 Ingest processing pipeline (canonical events only)
`q_ingest_events` consumes newly inserted canonical events (TradeEvent.isCanonical=true and ActivityEvent.isCanonical=true) and performs:

1) Normalize into internal canonical object (already mostly normalized)
2) Apply to **Shadow(User)** ledger
3) Feed aggregator for executable copies
4) Update snapshots incrementally (via `q_portfolio_apply`)

## 4.7 Shadow(User) ledger application (exact)
For each canonical TradeEvent:
- Write `LedgerEntry` for `portfolioScope=SHADOW_USER` and `followedUserId=<user>`
- `entryType=TRADE_FILL`
- `shareDeltaMicros` positive for BUY, negative for SELL
- `cashDeltaMicros` negative for BUY notional, positive for SELL notional
- `priceMicros` set

For MERGE/SPLIT ActivityEvent:
- Translate event payload into deterministic share deltas across involved assets
- Apply as `entryType=MERGE` or `SPLIT` with `cashDeltaMicros=0` unless event implies fees/cash movement
- If payload cannot be applied (should be rare), still store ActivityEvent but write a ledger entry with `MERGE_SPLIT_NOT_APPLICABLE` recorded in an audit log entry (or at least skip applying; v0 requires shadow apply “exactly as reported”, so implement the transformation per API spec).

> Don’t guess. Use the payload fields to compute exact token deltas.

## 4.8 Aggregation (locked)
Aggregation key: `(followedUserId, assetId, side)` for trades; `(followedUserId, type, involvedAssets)` for merge/split.

Window:
- 2000ms

Output:
- one “group” object with:
  - summed notional
  - volume-weighted reference price (for “their_reference_price”)
  - earliest detectTime for FIFO ordering

Group key string format (locked):
```
<followedUserId>:<assetId>:<side>:<windowStartIso>
```

## 4.9 Executable simulation (per-user + global)

### 4.9.1 Compute target notional (locked)
- `target = floor(their_group_notional * 0.01)`
- Clamp:
  - min = 5 USDC
  - max = min(250 USDC, 0.75% of bankroll equity)

### 4.9.2 Timing realism (locked)
Before fetching the book:
- sleep `750ms + random(0..250ms)`

### 4.9.3 Book fetch rule (locked)
Fetch **exactly once per group** from CLOB:
- no periodic book polling
- only on copy attempt

### 4.9.4 Price protection checks (locked)
Compute mid from book: `(bestBid + bestAsk)/2`.

Simulate fills into L2 asks/bids and compute your VWAP.

BUY must satisfy:
- VWAP <= their_ref + 0.01
- VWAP <= mid + 0.015

SELL must satisfy:
- VWAP >= their_ref - 0.01
- VWAP >= mid - 0.015

### 4.9.5 Spread filter (locked)
Skip if:
- (bestAsk - bestBid) > 0.02

### 4.9.6 Depth requirement (locked)
Compute available notional in-band (the same bounds you’ll use for simulation):
- require >= 1.25 × target notional

### 4.9.7 Partial fills (locked)
Allowed.
- If fill ratio 0%: SKIP with `NO_LIQUIDITY_WITHIN_BOUNDS`
- If partial: EXECUTE, record `filledRatioBps`, ledger uses filled notional/shares

### 4.9.8 Risk caps (locked)
Apply in this order:

1) Circuit breakers:
- If daily/weekly loss or drawdown breached → SKIP new opens (`CIRCUIT_BREAKER_TRIPPED`)
- Still allow closes (logic: detect that this group is reducing exposure; if reducing, allow)

2) Exposure caps:
- Total exposure <= 70% equity
- Per market <= 5% equity
- Per user <= 20% equity
If violated:
- per-user executable uses `RISK_CAP_USER`
- global uses `RISK_CAP_GLOBAL`

### 4.9.9 Global FIFO (locked)
Global executable processes event groups ordered by detect time. If two arrive same time, stable sort by groupKey.

## 4.10 Ledger application for executable portfolios (exact)
For each executed copy attempt:
- Write `CopyAttempt` row with:
  - portfolioScope EXEC_USER or EXEC_GLOBAL
  - decision EXECUTE/SKIP
  - reason codes (non-empty if SKIP)
  - target notional
  - filled notional + vwap + ratio

If EXECUTE (full or partial):
- Write `LedgerEntry` with:
  - portfolioScope EXEC_USER and followedUserId OR EXEC_GLOBAL with null user
  - entryType TRADE_FILL
  - shareDeltaMicros and cashDeltaMicros based on simulated fills (sum across ExecutableFill rows)
- Write `ExecutableFill` rows for each level consumed

If SKIP:
- No ledger entry for the trade (CopyAttempt is the record)

## 4.11 Snapshots & price refresh

### 4.11.1 MarketPriceSnapshot loop (locked)
Every **30 seconds**, compute set of **held assetIds** across all portfolios and fetch prices for those assets, then upsert `MarketPriceSnapshot` bucketed to the current 30s bucket (or minute if you want fewer writes—spec says 30 seconds, so use 30 seconds).

### 4.11.2 PortfolioSnapshot loop (locked)
Every **minute**, compute snapshots for:
- Global executable
- Each per-user executable
- Each per-user shadow

**Do not** recompute from scratch each time by scanning all history if it becomes heavy. Use:
- last snapshot + ledger entries since last snapshot.

With 3 users, this will be fast.

---

# Phase 5 — Web app (Next.js dashboard)

## 5.1 Create Next.js app (App Router)
In `apps/web`:

```bash
cd apps/web
pnpm dlx create-next-app@latest . --ts --app --eslint --tailwind --src-dir --no-import-alias
cd ../..
```

Install dependencies:

```bash
pnpm -C apps/web add @copybot/shared @prisma/client next-auth @auth/prisma-adapter recharts zod swr
```

(Use Prisma Adapter for NextAuth.)

## 5.2 Add shadcn/ui
In `apps/web`:

```bash
pnpm -C apps/web dlx shadcn@latest init
```

Install components you’ll use across pages (cards, tables, buttons, tabs, dialog, dropdown, badge, etc.).

## 5.3 NextAuth setup (locked: GitHub OAuth, single admin email)
### 5.3.1 Add Prisma Adapter tables
NextAuth requires models like `User`, `Account`, `Session`, `VerificationToken`.

Add these to `schema.prisma` (standard NextAuth Prisma adapter models). Then migrate.

### 5.3.2 Enforce single admin email
Use `AllowedAdminEmail` table:
- Seed it with `ADMIN_EMAIL`
- In NextAuth `signIn` callback:
  - allow only if email exists in `AllowedAdminEmail`

Result: **single admin**.

## 5.4 Web env vars (locked)
Web needs:
- `DATABASE_URL`
- `NEXTAUTH_URL` = `https://yourdomain.com`
- `NEXTAUTH_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

## 5.5 Implement API routes (locked list)
Create route handlers under `apps/web/src/app/api/...` for:

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
- `POST /api/control/pause`

Every route must:
- require NextAuth session
- validate inputs with Zod
- use Prisma singleton

## 5.6 Implement pages (locked set)
Pages (App Router):
1) Overview
2) Followed Users
3) User Detail
4) Global Portfolio
5) Trades & Copy Attempts
6) Markets
7) Config (global + per-user)
8) System Status

## 5.7 Polling (locked cadence)
Use SWR in client components:
- Overview: refresh 10s
- Trades/copy attempts: 5s
- System status: 10s
- Markets list: manual refresh or 30s

Charts:
- Recharts-based components (line chart for equity curve, bar chart for skip reasons, histograms for slippage & lag).

---

# Phase 6 — Docker & nginx & droplet hardening

## 6.1 Create Dockerfiles

### Worker Dockerfile (`docker/Dockerfile.worker`)
- multi-stage build
- install deps with pnpm
- compile TS
- run `node dist/index.js`

### Web Dockerfile (`docker/Dockerfile.web`)
- build Next.js standalone
- run with `node server.js` from standalone output

## 6.2 docker-compose.yml (locked services)
Create `docker/docker-compose.yml` with:
- db
- redis
- worker
- web
- nginx

Add volumes:
- `pgdata:/var/lib/postgresql/data`

Redis must be configured:
- `appendonly yes`
- `maxmemory-policy noeviction`

Mount a `docker/redis.conf` to enforce it.

## 6.3 nginx reverse proxy (locked)
`docker/nginx.conf` must:
- redirect HTTP → HTTPS
- proxy `/` to `web:3000`
- set headers: `X-Forwarded-For`, `X-Forwarded-Proto`, etc.
- set reasonable timeouts
- rate-limit auth endpoints if desired

## 6.4 Droplet setup (exact steps)

1) Provision droplet (Ubuntu 22.04 LTS)
2) SSH in, create non-root user, disable root login
3) Install docker + docker compose plugin
4) Enable firewall:
   - allow 22, 80, 443 only
5) Optional: fail2ban for SSH

## 6.5 TLS via Let’s Encrypt
- install `certbot` on host
- get cert for your domain
- mount certs into nginx container OR run nginx on host (v0 uses nginx in Docker; mount `/etc/letsencrypt` read-only)

---

# Phase 7 — Migrations, seeding, and first run

## 7.1 Run migrations
From repo root with docker running:

```bash
pnpm prisma migrate dev
```

(or in prod: `pnpm prisma migrate deploy`)

## 7.2 Seed admin email
Write a seed script (Node) that inserts one row into `AllowedAdminEmail` for `ADMIN_EMAIL`.

Run it once.

## 7.3 Insert global config defaults (locked)
Insert one `GuardrailConfig` row with scope GLOBAL and JSON matching:
- maxWorseningVsTheirFillMicros=10_000
- maxOverMidMicros=15_000
- maxSpreadMicros=20_000
- minDepthMultiplierBps=12_500
- noNewOpensWithinMinutesToClose=30
- decisionLatencyMs=750
- jitterMsMax=250
- maxTotalExposureBps=7000
- maxExposurePerMarketBps=500
- maxExposurePerUserBps=2000
- dailyLossLimitBps=300
- weeklyLossLimitBps=800
- maxDrawdownLimitBps=1200

Insert one `CopySizingConfig` row with scope GLOBAL:
- copyPctNotionalBps=100
- minTradeNotionalMicros=5_000_000
- maxTradeNotionalMicros=250_000_000
- maxTradeBankrollBps=75

## 7.4 Add your 3 followed users
Insert 3 `FollowedUser` rows (label + profileWallet). Leave proxies empty; worker will discover and populate.

## 7.5 Run the stack locally
```bash
docker compose -f docker/docker-compose.yml up --build
```

Confirm:
- web loads
- auth works (only your admin email can sign in)
- worker health endpoint responds internally
- worker logs show:
  - startup backfill 15 minutes
  - polling every 30s
  - reconcile every 60s

---

# Phase 8 — Verification & correctness checks (before deployment)

## 8.1 Idempotency tests (must pass)
1) Let worker ingest some events.
2) Restart worker container.
3) Confirm:
- no duplicate LedgerEntry rows (unique constraints protect this)
- CopyAttempt uniqueness holds
- snapshots continue smoothly

## 8.2 WS failure test
- kill worker’s network temporarily (or stop the WS connection)
- confirm reconnect happens and reconcile runs
- confirm canonical ingestion continues

## 8.3 Rate limit safety
- add logs to show request counts per minute to known endpoints
- verify they stay low (with 3 users, they will)

---

# Phase 9 — Deploy to DigitalOcean

## 9.1 Deploy code
- push to GitHub
- on droplet: clone repo
- create `.env` file used by docker compose (permissions 600)

## 9.2 Start services
```bash
docker compose -f docker/docker-compose.yml up -d --build
```

## 9.3 Confirm externally
- `https://yourdomain.com` loads
- login works
- Overview populates
- System Status shows healthy

---

# Phase 10 — Dashboard completion (ensure it matches spec)

For each page, confirm the exact required widgets are implemented:

1) Overview:
- global equity curve
- PnL stats, drawdown, win rate
- exposure summary
- top markets/users
- system health
- pause/resume

2) Followed Users:
- shadow vs executable metrics table
- enable/disable

3) User Detail:
- shadow vs executable curves
- tracking gap
- attempt/fill/partial
- slippage + lag distributions
- skip reasons
- positions
- trade feed

4) Global Portfolio:
- open positions
- exposure breakdown
- drawdown/risk utilization

5) Trades & Copy Attempts:
- detected trades tab
- copy attempts tab with reason codes + filters

6) Markets:
- liquidity stats
- slippage history
- positions
- market blacklist toggle

7) Config:
- global config editor
- per-user overrides editor
- test config on last 24h

8) System Status:
- queue depth + DLQ count
- last processed event time
- last backfill
- error rates
- DB/snapshot freshness

---

# Phase 11 — Backups & runbooks (required for “done”)

## 11.1 Nightly Postgres backup
Add cron job on host:

- `pg_dump` from db container
- compress
- keep 7 days
- upload off-droplet (DO Spaces recommended)

## 11.2 Redis persistence
Ensure redis.conf:
- `appendonly yes`
- `maxmemory-policy noeviction`

## 11.3 Runbooks (must exist in repo)
Create `RUNBOOKS.md` containing:
- redeploy steps
- restore from backup steps
- backfill last X hours (adjust checkpoints + run reconcile)
- clear stuck jobs safely

---

# Phase 12 — Acceptance criteria (final checklist)

You’re done only when all are true:

### Data correctness
- Shadow(User) matches detected canonical events (spot-check 50)
- Executable(User) creates CopyAttempts with correct sizing + guardrail decisions
- Global executable respects FIFO and caps

### Reliability
- Restart worker: no duplicates, resumes, backfills
- WS drop: reconnect + reconcile heals gaps
- 429 simulation: backoff + recovery

### Dashboard
- All pages exist and match the locked spec
- Charts read from snapshots (fast)
- Polling intervals match spec

---

## End state
After completing every step above, you’ll have the exact v0 described in **planning.md**:
- paper trading only
- canonical ingestion via Data API
- WS-triggered reconcile and verification
- per-user shadow and executable portfolios
- global executable portfolio
- full dashboard with tunable guardrails globally and per user
- rate-limited, fault-tolerant, restart-safe system on a $12 droplet
