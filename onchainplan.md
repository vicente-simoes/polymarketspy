# On-chain First Detection Plan (v0→v0.1 Architecture Change)

This document specifies an **architecture change** for the project: move from **Data-API-canonical detection** to **on-chain WS-first detection** so that trades appear and copy-attempts run **within seconds** of block inclusion, without waiting for Polymarket Data API indexing.

This plan is written to be a clear source of truth for the architectural direction, while leaving room for **code-level implementation details** (Claude Code will implement).

---

## 1) Motivation

### Current behavior (problem)
- Alchemy WS currently triggers a reconcile, but the system only treats **Polymarket Data API** trades as canonical.
- As a result:
  - Trades are often recorded with `source = POLYMARKET_API`
  - Detection lag frequently equals **Data API indexing lag** + polling interval (30–90s observed)
  - Dashboard shows trades/copy attempts late even when WS is healthy

### Desired behavior (goal)
- On-chain logs should drive detection and copy attempts immediately:
  - A trade should appear in the dashboard **as soon as the relevant log is observed**
  - A copy attempt should be evaluated **immediately** (subject to guardrails and simulation latency)
- Polymarket APIs become **enrichment**, not a bottleneck.

---

## 2) High-level architecture (new)

### Data sources
- **Alchemy WebSocket logs**: primary fast path (WS-first)
- **Polymarket Data API / Gamma / CLOB**: enrichment + metadata + mark-to-market + order book

### Core idea
- A WS log is converted into a minimal but **usable** `OnchainTrade` object.
- This object is inserted and processed through the same aggregation/copy pipeline as API trades.
- Later, the trade is enriched with:
  - market title, event info, close time
  - token/outcome labels
  - any API trade IDs and fees if needed for UI

---

## 3) Exchange contracts (must subscribe to both)

Polymarket trades can occur on:
- **Legacy CTF Exchange**
- **Neg Risk CTF Exchange**

We must subscribe to both exchange contract addresses (Polygon mainnet). The exact addresses are already defined in `types.ts` as `CTF_EXCHANGE_ADDRESSES`.

**Requirement:** WS must listen to both, otherwise fills in neg-risk markets will be missed.

---

## 4) Which events to parse

### Primary event: OrderFilled
The exchanges emit an `OrderFilled` event which includes (at minimum):
- maker (indexed)
- taker (indexed)
- makerAssetId
- takerAssetId
- makerAmountFilled
- takerAmountFilled
- fee (on OrderFilled; may be absent in other events)

### Optional event: OrdersMatched
Some fills may be represented or better attributed using `OrdersMatched` which includes:
- takerOrderMaker (indexed)
- makerAssetId / takerAssetId
- makerAmountFilled / takerAmountFilled

**v0.1 requirement:** Start with `OrderFilled` parsing. Add `OrdersMatched` if needed for attribution completeness.

---

## 5) Wallet targeting (track only followed wallets)

### WS filtering approach
Because maker and taker are indexed in `OrderFilled`, we can filter by followed wallets via topic filters:

- subscription A: OrderFilled where **maker ∈ followedWallets**
- subscription B: OrderFilled where **taker ∈ followedWallets**

This restricts inbound WS volume and avoids processing unrelated trades.

**Note:** Many users trade through proxy wallets or relayers. The filter should be applied to the wallet that appears in the event fields, not `tx.from`.

---

## 6) Minimal OnchainTrade object (WS → usable trade)

### Objective
From a single `OrderFilled` log, produce a trade record sufficient to:
- attribute the trade to a followed user
- identify the traded outcome token
- compute side (BUY/SELL) from the followed user’s perspective
- compute notional, size, and price
- run copy sizing and L2 simulation immediately

### Fields (minimum)
An `OnchainTrade` must include:

**Identity / idempotency**
- `source = "ONCHAIN_WS"`
- `txHash`
- `logIndex`
- `blockNumber`
- `exchangeAddress`
- `eventName` (OrderFilled)
- A deterministic `eventKey` based on `(txHash, logIndex)` or `(blockNumber, logIndex)`.

**Participants**
- `maker`
- `taker`
- `followedWallet` (the wallet we attribute this trade to)
- `role` (MAKER or TAKER from the event)

**Assets and amounts**
- `makerAssetId`
- `takerAssetId`
- `makerAmountFilled`
- `takerAmountFilled`

**Derived fields**
- `tokenId` (the non-zero assetId; see below)
- `usdcAmount` (the amount corresponding to assetId == 0)
- `tokenAmount` (the amount corresponding to tokenId)
- `side` (BUY/SELL from followed wallet perspective)
- `price` (probability price in micros: 0..1_000_000)
- `notional` (USDC micros)

**Timestamps**
- `detectTime = now()` when WS message received
- `eventTime = block timestamp` (can be filled via a block timestamp cache; acceptable to insert initially and update later)

### How to compute tokenId / USDC / side / price
Polymarket exchanges use:
- `assetId == 0` to represent the **collateral token** (USDC)

Algorithm:
1) Identify which side of the fill used USDC:
   - If `makerAssetId == 0`: maker gave USDC, taker gave token
   - If `takerAssetId == 0`: taker gave USDC, maker gave token
   - Exactly one of makerAssetId / takerAssetId should be 0 for a standard outcome token fill.

2) Set:
   - `tokenId = (makerAssetId == 0) ? takerAssetId : makerAssetId`
   - `usdcAmount = (makerAssetId == 0) ? makerAmountFilled : takerAmountFilled`
   - `tokenAmount = (makerAssetId == 0) ? takerAmountFilled : makerAmountFilled`

3) Determine side from the **followed wallet** point of view:
   - If followed wallet is the party paying USDC and receiving token → **BUY**
   - If followed wallet is receiving USDC and paying token → **SELL**
   - (Implementation will need to check whether followed wallet is maker or taker, and combine with which assetId is USDC.)

4) Compute price in micros:
   - Price is effectively `usdcAmount / tokenAmount`.
   - Convert to `priceMicros = floor( (usdcMicros * 1_000_000) / tokenAmountMicros )`
   - Ensure integer math; no floats.

**Implementation note:** The units for amounts (USDC vs token) may be different decimals; treat both as raw integers from logs and normalize to the internal “micros” convention consistently.

---

## 7) Token → Market mapping (avoid Data API dependency)

We need to map `tokenId` to `conditionId` (and later market metadata). Two approaches are acceptable:

### Approach A (preferred): On-chain TokenRegistered cache
Subscribe to `TokenRegistered(token0, token1, conditionId)` emitted by the exchange registry and build a local mapping:
- tokenId → conditionId
- tokenId → complementTokenId

This allows immediate association of the trade to a condition/market without Data API.

### Approach B (fallback): RPC call with caching
Use the exchange registry method `getConditionId(tokenId)` via `eth_call` and cache results.

**Requirement:** The system must not spam RPC; caching is mandatory.

---

## 8) Database changes (high-level)

### Add a new “WS trade” canonical path
We will store WS-detected trades as first-class trade records.

Two viable designs (code-level decision):
1) Extend existing `TradeEvent` to support WS-first canonical trades:
   - `source = "ONCHAIN_WS"`
   - `isCanonical = true` for WS trades
   - `sourceId` optional; uniqueness driven by `(txHash, logIndex)`
   - Later enrichment updates additional columns (marketId/assetId, fee, etc.)
2) Add a dedicated table `OnchainTradeEvent` and unify later:
   - Keep WS records separate, link them to later API trades via txHash/logIndex.

**Requirement:** Regardless of table layout, the aggregation/copy pipeline must consume WS trades without waiting for Data API.

### Add enrichment state
We need a way to indicate “minimal record” vs “enriched record”, e.g.:
- `enriched: boolean`
- or `enrichmentStatus: enum`
- or `enrichedAt: timestamp nullable`

Exact schema is a code-level decision.

---

## 9) Pipeline changes (high-level)

### Current pipeline (simplified)
- Data API poll → insert canonical TradeEvent → aggregate → simulate → copy attempt

### New pipeline
**Fast path**
- WS log → decode → create OnchainTrade → insert → aggregate → simulate → copy attempt (immediate)

**Slow path (enrichment)**
- enrichment worker periodically:
  - maps tokenId → conditionId (on-chain cache/RPC)
  - pulls market metadata from Gamma/Data APIs
  - optionally reconciles with Data API trades for fees/trade IDs
  - updates the existing DB rows in-place

**Important:** enrichment must never block copy attempt creation.

---

## 10) UI / dashboard representation (high-level)

### Trade source display
The dashboard should show:
- `source = ONCHAIN_WS` immediately for the new record
- Later, once enriched, it may show:
  - `source = ONCHAIN_WS (enriched)`
  - and optionally reference an associated Data API trade id / tx hash

### Copy attempt timing
Copy attempts should appear immediately after WS detection + simulation latency.
If enrichment arrives later, it can retroactively update “market title/outcome label” in UI without altering the recorded copy attempt decision.

---

## 11) Reliability / safety considerations

- **Idempotency:** WS inserts must be protected by unique key `(txHash, logIndex)` to avoid duplicates during reconnect/backfill.
- **WS reconnect:** must handle close/error and resubscribe.
- **Backfill:** On reconnect, replay last N blocks or time window for missed logs.
- **Partial fills:** Multiple logs per tx are normal; treat each log as an event and aggregate within the existing 2s window.
- **Proxy wallets:** Followed “user address” may be different from on-chain trading proxy; we must treat whichever wallet appears in maker/taker as the actor, and maintain mapping in DB.

---

## 12) Implementation sequencing (recommended)

1) Add WS-first trade record creation:
   - decode OrderFilled
   - persist minimal trade rows
   - ensure aggregation consumes them

2) Add tokenId→conditionId mapping:
   - implement cache via TokenRegistered OR getConditionId+cache
   - attach conditionId to trade rows

3) Add enrichment worker:
   - Gamma/Data API calls to fill market title/outcome labels/close time
   - ensure rate limiting

4) Update dashboard:
   - show WS-first trades immediately
   - show “enrichment pending” state where metadata is missing

5) Verify with known tx hashes:
   - The trades linked by the user should show as detected via WS quickly
   - Copy attempt should appear quickly
   - Later enrichment should fill in labels

---

## 13) Non-goals (unchanged)
- Still paper trading only.
- Still uses order-book simulation from CLOB for copy attempts.
- Still stores money as integer micros.
- Still uses the same guardrails and copy sizing defaults unless explicitly changed.

---

## 14) Open implementation decisions (intentionally left flexible)
These are left for implementation-time choices:
- Whether to extend `TradeEvent` vs create a new WS trade table.
- Exact decoding library usage (ethers Interface vs ABI fragments).
- Exactly how to normalize token decimals into `shareMicros` vs raw amounts.
- Exact enrichment schedule and batching strategy.
- Whether to implement TokenRegistered subscription immediately or start with `getConditionId` calls plus caching.
