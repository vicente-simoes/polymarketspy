# On-chain First Implementation Plan

This document details the implementation steps for the v0→v0.1 architecture change described in `onchainplan.md`.

---

## Overview

**Goal:** WS-detected trades become canonical immediately and flow through the copy pipeline without waiting for Polymarket Data API.

**Current state:** WS inserts non-canonical TradeEvent → triggers reconcile → API fetch creates canonical trade → pipeline processes.

**Target state:** WS inserts canonical TradeEvent immediately → pipeline processes → async enrichment fills metadata later.

---

## Resolved Design Decisions

### 1. Decimal Handling
- **All amounts (USDCe + outcome tokens) are 6 decimals**
- Store as `bigint` micros internally
- Convert to human units: `amount = amountMicros / 1e6`
- Rationale: Outcome tokens are created by splitting USDCe 1:1, so quantities match collateral base units
- Future-proofing: Store `COLLATERAL_DECIMALS = 6` as config constant

### 2. Order Book Fetch
- **Fetch by `token_id` directly from OrderFilled log**
- The outcome token ID is: `makerAssetId === 0 ? takerAssetId : makerAssetId`
- Use CLOB endpoints:
  - `GET https://clob.polymarket.com/book?token_id={outcomeTokenId}`
  - `GET https://clob.polymarket.com/price?token_id={outcomeTokenId}&side=buy|sell`
- No need for conditionId → marketId mapping for book fetch

### 3. Proxy Wallets
- **Log addresses ARE proxy wallets** (Safe/Magic proxy), not EOAs
- Track proxy wallet addresses as primary identifiers
- Store optional `ownerEOA` when available, but don't rely on it for detection
- Gamma profile lookup works with either proxy or EOA

### 4. Fee Handling
- **Use fee from on-chain event immediately**
- Fee is paid by the maker of that specific OrderFilled event
- Store as `feeMicros: bigint`
- Include in cash delta accounting
- Can verify against API data during enrichment (optional)

---

## Phase 1: Schema Changes

### 1.1 Add enrichment status to TradeEvent

```prisma
enum EnrichmentStatus {
  PENDING      // WS-first, minimal data only
  ENRICHED     // Market metadata filled
  FAILED       // Enrichment failed (after retries)
}

model TradeEvent {
  // ... existing fields ...

  // New fields for WS-first support
  enrichmentStatus  EnrichmentStatus  @default(ENRICHED)  // Existing API trades are already enriched
  enrichedAt        DateTime?

  // New: raw token ID from WS log (the outcome token)
  rawTokenId        String?           // Non-USDC assetId from OrderFilled

  // conditionId can be derived later via enrichment if needed
  conditionId       String?
}
```

### 1.2 Add token metadata cache table

```prisma
model TokenMetadataCache {
  tokenId       String    @id           // Outcome token ID (BigInt as string)
  conditionId   String?                 // CTF conditionId (from on-chain or API)
  marketId      String?                 // Polymarket market ID
  marketSlug    String?                 // For display
  outcomeLabel  String?                 // "Yes" / "No" / custom outcome
  marketTitle   String?                 // Full market question
  closeTime     DateTime?               // Market close time
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([conditionId])
  @@index([marketId])
}
```

### 1.3 Migration

```bash
pnpm prisma migrate dev --name add_ws_first_support
```

---

## Phase 2: WS Log Parsing Enhancement

### 2.1 Constants and types

**File:** `apps/worker/src/alchemy/types.ts` (extend existing)

```typescript
// Collateral config (future-proofing)
export const COLLATERAL_DECIMALS = 6;
export const USDC_ASSET_ID = 0n;  // assetId == 0 means USDC in OrderFilled

// Decoded OrderFilled with all derived fields
export interface DecodedOrderFilled {
  // From log
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp?: number;  // Filled via block lookup if available
  exchangeAddress: string;

  // Raw event fields
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee: bigint;

  // Derived fields
  outcomeTokenId: string;     // The non-USDC assetId (as string for DB)
  usdcAmountMicros: bigint;   // USDC side amount
  tokenAmountMicros: bigint;  // Token side amount
  followedWallet: string;     // Which tracked wallet is involved
  role: 'MAKER' | 'TAKER';    // Role of followed wallet in this fill
  side: 'BUY' | 'SELL';       // From followed wallet perspective
  priceMicros: number;        // 0..1_000_000
  notionalMicros: bigint;     // USDC micros
  shareMicros: bigint;        // Token micros
  feeMicros: bigint;          // Fee in USDC micros
}
```

### 2.2 Derivation logic

**File:** `apps/worker/src/alchemy/decoder.ts` (new file)

```typescript
export function deriveTradeFields(
  log: RawOrderFilledLog,
  followedWallet: string
): DecodedOrderFilled {
  const { maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee } = log;

  // 1. Identify USDC side (assetId == 0 is USDC)
  const makerGaveUsdc = makerAssetId === USDC_ASSET_ID;

  // 2. Extract outcome token ID (the non-zero assetId)
  const outcomeTokenId = makerGaveUsdc
    ? takerAssetId.toString()
    : makerAssetId.toString();

  // 3. Extract amounts
  const usdcAmountMicros = makerGaveUsdc ? makerAmountFilled : takerAmountFilled;
  const tokenAmountMicros = makerGaveUsdc ? takerAmountFilled : makerAmountFilled;

  // 4. Determine role of followed wallet
  const isMaker = maker.toLowerCase() === followedWallet.toLowerCase();
  const role = isMaker ? 'MAKER' : 'TAKER';

  // 5. Determine side from followed wallet perspective
  // If followed wallet gave USDC → BUY (received tokens)
  // If followed wallet received USDC → SELL (gave tokens)
  const followedGaveUsdc = (isMaker && makerGaveUsdc) || (!isMaker && !makerGaveUsdc);
  const side = followedGaveUsdc ? 'BUY' : 'SELL';

  // 6. Compute price in micros (integer math, no floats)
  // price = usdcAmount / tokenAmount
  // priceMicros = (usdcAmount * 1_000_000) / tokenAmount
  const priceMicros = tokenAmountMicros > 0n
    ? Number((usdcAmountMicros * 1_000_000n) / tokenAmountMicros)
    : 0;

  // 7. Amounts are already in micros (6 decimals)
  const notionalMicros = usdcAmountMicros;
  const shareMicros = tokenAmountMicros;
  const feeMicros = fee;

  return {
    ...log,
    outcomeTokenId,
    usdcAmountMicros,
    tokenAmountMicros,
    followedWallet,
    role,
    side,
    priceMicros,
    notionalMicros,
    shareMicros,
    feeMicros,
  };
}
```

### 2.3 Update subscription to create canonical trades

**File:** `apps/worker/src/alchemy/subscription.ts` (modify existing)

Current behavior:
- Decode log minimally
- Insert non-canonical TradeEvent
- Enqueue reconcile job

New behavior:
- Decode log fully using `deriveTradeFields()`
- Insert CANONICAL TradeEvent with:
  - `source: "ONCHAIN_WS"`
  - `isCanonical: true`
  - `enrichmentStatus: PENDING`
  - All computed fields (side, price, notional, shares, fee)
  - `rawTokenId: outcomeTokenId`
  - Nullable: marketId, market metadata (filled by enrichment)
- Enqueue to `q_ingest_events` (same as API path)
- Skip reconcile enqueue (no longer needed for this trade)

---

## Phase 3: Pipeline Adjustments

### 3.1 Shadow ledger

**File:** `apps/worker/src/portfolio/shadow.ts`

- Already consumes TradeEvent by ID
- Verify it works with nullable marketId
- Adjust if it requires any enrichment-only fields

### 3.2 Aggregator

**File:** `apps/worker/src/simulate/aggregator.ts`

- Currently groups by `(followedUserId, assetId, side)`
- For WS-first: use `rawTokenId` as the grouping key when `assetId` is null
- Update grouping logic: `assetId ?? rawTokenId`

### 3.3 Copy executor - Order book fetch

**File:** `apps/worker/src/simulate/executor.ts`

Current: Uses marketId to fetch order book.

New: Use `rawTokenId` directly with CLOB:
```typescript
// Fetch order book by token_id
const bookUrl = `https://clob.polymarket.com/book?token_id=${trade.rawTokenId}`;

// Fetch price by token_id
const priceUrl = `https://clob.polymarket.com/price?token_id=${trade.rawTokenId}&side=${side}`;
```

Update book fetching to support both:
- `marketId` path (existing API trades)
- `rawTokenId` path (WS-first trades)

---

## Phase 4: Enrichment Worker

### 4.1 New enrichment processor

**File:** `apps/worker/src/enrichment/processor.ts` (new file)

```typescript
// Responsibilities:
// 1. Poll for trades with enrichmentStatus = PENDING
// 2. For each unique rawTokenId not in TokenMetadataCache:
//    a. Fetch from Gamma API: /markets?clob_token_ids={tokenId}
//    b. Extract: marketId, marketSlug, outcomeLabel, marketTitle, closeTime
//    c. Optionally fetch conditionId via RPC or API
//    d. Insert into TokenMetadataCache
// 3. For each pending trade:
//    a. Look up TokenMetadataCache by rawTokenId
//    b. Update TradeEvent with marketId, conditionId from cache
//    c. Set enrichmentStatus = ENRICHED, enrichedAt = now()
// 4. Rate limit API calls (respect Gamma limits)
// 5. Mark FAILED after N retries with reason
```

### 4.2 Enrichment schedule

- Run every 15 seconds
- Process up to 50 pending trades per batch
- Batch token lookups (one Gamma call can include multiple token IDs)
- Exponential backoff on API failures
- Mark FAILED after 5 retries

### 4.3 Integration

- Add to worker startup sequence after other workers
- No new queue needed (simple polling loop)
- Log enrichment latency metrics

---

## Phase 5: Reconcile Changes

### 5.1 Simplify reconcile role

**File:** `apps/worker/src/reconcile/processor.ts`

Current: Reconcile fetches canonical trades from API on every WS trigger.

New behavior:
- **Remove** reconcile enqueue from WS subscription (WS trades are now canonical)
- **Keep** periodic reconcile as safety net:
  - Every 60s, check for trades in API that we don't have
  - Insert as `source: "POLYMARKET_API"` only if not already present (by txHash/logIndex)
  - This catches edge cases: WS disconnect, missed logs, etc.

### 5.2 Backfill on reconnect

- On WS reconnect, still trigger backfill for recent blocks
- But now backfill creates canonical WS trades directly
- No need to wait for API

---

## Phase 6: Dashboard Updates

### 6.1 Trade source display

Show source with enrichment status:
- `ONCHAIN_WS` + PENDING → "On-chain (enriching...)"
- `ONCHAIN_WS` + ENRICHED → "On-chain"
- `POLYMARKET_API` → "API"

### 6.2 Handle missing metadata gracefully

When enrichment is pending:
- Market title: Show "Market #[tokenId truncated]" or spinner
- Outcome: Show "Position" generically
- Update automatically when enrichment completes (React Query refetch)

### 6.3 Latency display

- Show `detectTime` prominently (now = WS detection time, very fast)
- Copy attempts should show much lower latency

---

## Phase 7: Testing & Verification

### 7.1 Unit tests

- `deriveTradeFields()` - all combinations:
  - Maker gave USDC, followed is maker → BUY
  - Maker gave USDC, followed is taker → SELL
  - Taker gave USDC, followed is maker → SELL
  - Taker gave USDC, followed is taker → BUY
- Price computation edge cases (small amounts, rounding)
- Fee extraction

### 7.2 Integration tests

- Mock WS log → full pipeline → CopyAttempt created
- Idempotency: same log twice = one trade
- Enrichment updates existing trades correctly
- Order book fetch works with rawTokenId

### 7.3 Manual verification

- Use known tx hashes from followed wallets
- Verify trades appear within seconds of block
- Verify copy attempts trigger quickly (~3s after detection + 2s aggregation)
- Verify enrichment fills metadata within 60s

---

## Implementation Order

```
Phase 1: Schema changes           ~30 min
  - Add EnrichmentStatus enum
  - Add fields to TradeEvent
  - Add TokenMetadataCache table
  - Generate and run migration

Phase 2: WS parsing enhancement   ~2 hours
  - Create decoder.ts with deriveTradeFields()
  - Update subscription.ts to create canonical trades
  - Update types.ts with new interfaces

Phase 3: Pipeline adjustments     ~1-2 hours
  - Update aggregator grouping key
  - Update executor to fetch book by tokenId
  - Verify shadow ledger works with minimal trades

Phase 4: Enrichment worker        ~1-2 hours
  - Create enrichment/processor.ts
  - Add Gamma API integration
  - Add to worker startup

Phase 5: Reconcile changes        ~30 min
  - Remove reconcile from WS trigger
  - Keep periodic safety-net reconcile

Phase 6: Dashboard updates        ~1 hour
  - Update trade display components
  - Handle pending enrichment state

Phase 7: Testing                  ~1 hour
  - Add unit tests for decoder
  - Manual verification with real trades
```

---

## File Change Summary

### New files
- `apps/worker/src/alchemy/decoder.ts` - Trade field derivation logic
- `apps/worker/src/enrichment/processor.ts` - Async enrichment worker
- `apps/worker/src/enrichment/gamma.ts` - Gamma API client for metadata

### Modified files
- `prisma/schema.prisma` - New enum, fields, table
- `apps/worker/src/alchemy/types.ts` - New interfaces
- `apps/worker/src/alchemy/subscription.ts` - Create canonical trades
- `apps/worker/src/simulate/aggregator.ts` - Support rawTokenId grouping
- `apps/worker/src/simulate/executor.ts` - Fetch book by tokenId
- `apps/worker/src/portfolio/shadow.ts` - Handle nullable fields
- `apps/worker/src/reconcile/processor.ts` - Simplify role
- `apps/worker/src/index.ts` - Start enrichment worker
- `apps/web/` components - Display enrichment status

---

## Success Criteria

1. **Latency:** Trades appear in dashboard within 5 seconds of block inclusion
2. **Copy timing:** Copy attempts created within 3 seconds of trade detection (+ 2s aggregation window)
3. **Correctness:** Shadow portfolio matches followed user exactly (spot-check)
4. **Enrichment:** Market metadata fills within 60 seconds for 95% of trades
5. **Reliability:** No duplicate trades on WS reconnect
6. **Idempotency:** Worker restart-safe, no duplicates
