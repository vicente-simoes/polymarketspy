# Live Trading Mode — key info for PolymarketSpy

Goal: add a **parallel execution mode** that can be **enabled/disabled** (global + per-followed-user), where copy intents are executed as **real Polymarket CLOB orders** instead of paper-simulated fills. When live is OFF, the app behaves exactly as it does today.

This doc is intentionally “planning fuel” (not a step-by-step build plan).

---

## 1) What “similar % return” means (and what breaks it)

If you copy *most* of the leader’s trades and size each copy as a stable fraction `r_u` of the leader’s **position deltas**, you can often track their **percentage returns reasonably well** at smaller notional.

You will NOT get perfect matching % return because of unavoidable tracking error:
- Missed trades (downtime, ingestion gaps, reconnect delays)
- Latency → different book state → slippage vs leader
- Partial fills (especially with FAK)
- Exchange constraints (min order size, tick size rounding)
- Your own guardrails (price-per-share skip, bankroll caps, min/max notional, whale filters)
- Inventory constraints (can’t sell what you don’t hold; may lack USDC to buy)
- Settlement / resolution timing differences vs the leader’s lifecycle

So your live mode claim should be:
> “We aim to track leader exposure changes closely; % returns are often similar but not guaranteed.”

---

## 2) Clean architecture: keep “strategy” shared, swap only execution

### Shared pipeline (paper + live)
1) **Ingest** leader trades → normalize into `LeaderTradeEvent`
2) **Decision engine** (shared):
   - price-per-share cap (e.g. skip > 0.97)
   - min/max leader trade notional to consider
   - min/max copy notional
   - max % bankroll per trade
   - optional: small-trade batching/netting (already implemented; can remain OFF by default)
   - optional: FIXED_RATE vs BUDGETED_DYNAMIC sizing
3) Output a single `CopyIntent`:
   - tokenId (outcome asset_id)
   - side (BUY/SELL)
   - target size (shares) and/or target notional
   - execution guardrail price (max buy price / min sell price)
   - orderType preference (FAK/FOK/GTC)
   - idempotencyKey (critical)

### Execution adapters (mode-specific)
- **PaperExecutor**: simulate fill vs book snapshot/cache
- **LiveExecutor**:
  - use freshest book (REST or market-channel WS cache)
  - compute price/size (respect tick size + min size)
  - place CLOB order
  - track lifecycle via **User Channel** WS and persist fills

This is how you add live trading without contaminating the rest of the system.

---

## 3) Polymarket CLOB order mechanics you must respect

### You place orders on outcome tokens
- Orders are placed on an **outcome token** (`tokenID` / `asset_id`).
- “YES” and “NO” are separate token IDs per market.

### Order types: GTC / FAK / FOK
- **GTC (Good-Til-Cancelled)**: normal limit order; can rest on the book.
- **FAK (Fill-And-Kill)**: execute immediately for whatever can fill now, cancel remainder.
- **FOK (Fill-Or-Kill)**: must fill fully immediately; otherwise cancel entirely.

Polymarket docs treat “market orders” as **marketable limit orders** using **FAK or FOK** (you intentionally cross the spread).

### Core order fields (conceptually)
- `tokenID`
- `side` (BUY/SELL)
- `price` (USDC/share)
- `size` (shares)
- `orderType` (GTC/FAK/FOK)
- optional `negRisk`
- optional `postOnly`

Notional is derived: **`notional = price * size`**.

### Exchange constraints you will hit in live mode
These are the big ones to design around:
- **Tick size**: price must snap to the market’s tick increments → otherwise `INVALID_ORDER_MIN_TICK_SIZE`
- **Minimum order size**: too small → `INVALID_ORDER_MIN_SIZE`
- **postOnly**: if you set `postOnly=true` but your order would cross the book → `INVALID_ORDER_POST_ONLY`

This is *exactly* why $0.01 “paper fills” are not a good live proxy unless you round/aggregate.

---

## 4) Practical execution policy for copy trading (live)

### Default recommendation
Use **FAK** for copy-trade execution, with a **slippage cap**:
- BUY: base on `bestAsk`, cap with `maxBuyPrice = bestAsk * (1 + slippageBps)`
- SELL: base on `bestBid`, cap with `minSellPrice = bestBid * (1 - slippageBps)` (implemented as a limit price)

Then:
- round price to tick size
- compute size from your intended notional (or copy shares directly)
- place **FAK** marketable limit

### When to use FOK
Use **FOK** when “partial is worse than nothing”:
- you’d rather skip than drift exposure
- you’re doing a correction / reconcile trade
- the market is thin and partials will just create noise

**Tradeoff**
- FAK → higher fill probability, more partials → more tracking drift
- FOK → cleaner tracking, more “missed trade” events

---

## 5) Sizing modes and how `r_u` fits

### FIXED_RATE (baseline)
- `r_u` is constant per user (or global), e.g. 0.01
- Copy notional delta ≈ `leaderDeltaNotional * r_u`, then apply caps/filters

### BUDGETED_DYNAMIC (your “whale-safe” mode)
- allocate budget `B_u` per followed user
- estimate leader exposure `E_u` (positions value proxy)
- compute effective rate:
  - `r_u = clamp(B_u / E_u, r_min, r_max)`

Then apply the same “copy deltas” logic as fixed rate.

Key reality:
- if you don’t copy every trade, you drift. Budgeted dynamic helps prevent domination, not eliminate drift.

---

## 6) Live Trading dashboard page (MVP requirements)

You want it operationally useful, like Copy Attempts.

### Status panel
- Live trading: ON/OFF (global)
- Paper trading: ON/OFF (global)
- Per-user live state: inherit / force ON / force OFF
- CLOB auth status
- WS status:
  - User Channel connected?
  - Market Channel connected?
- Last order placed time
- Last error

### Tables (minimum)
1) **Live Orders**
   - createdAt, followedUser, tokenId, side, price, size, orderType, status, filled size
2) **Live Fills**
   - orderId, tradeId, matchedAt, price, size, status (MATCHED / CONFIRMED / FAILED)
3) **Skipped / Rejected**
   - reason codes (price cap, min size, tick size, bankroll cap, etc.)
4) **Positions snapshot**
   - tokenId, shares, avg entry (optional), est value (optional), PnL (optional)

### Kill switches
- Global emergency OFF
- Per-user OFF

---

## 7) Ops + safety (non-negotiable for live money)

- **Shadow mode** first: generate/record would-be live orders, place none.
- **Idempotency**: every CopyIntent must have a deterministic idempotencyKey to prevent duplicates.
- **Retries** must check order state before re-posting.
- **Secrets**:
  - never bake into images
  - inject runtime env vars / docker secrets
  - never log secrets

---

## 8) Reference docs (keep handy)

```text
CLOB Overview
https://docs.polymarket.com/developers/CLOB/overview

CLOB Quickstart (TS client, API key derive/create)
https://docs.polymarket.com/developers/CLOB/quickstart

Order Management — Place Single Order (GTC/FAK/FOK + errors)
https://docs.polymarket.com/developers/CLOB/order-management/place-single-order

Websocket — User Channel (order + trade updates)
https://docs.polymarket.com/developers/CLOB/websocket/user-channel

Websocket — Market Channel (book updates)
https://docs.polymarket.com/developers/CLOB/websocket/market-channel

Glossary (includes FAK/FOK definitions)
https://docs.polymarket.com/quickstart/reference/glossary

API Rate Limits
https://docs.polymarket.com/quickstart/reference/api-rate-limits

Bridge & Swap overview (funding; USDC.e on Polygon)
https://docs.polymarket.com/developers/bridge-swap/overview

Proxy wallet overview
https://docs.polymarket.com/developers/proxy-wallets/proxy-wallet