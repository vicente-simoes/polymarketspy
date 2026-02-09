# User Channel WebSocket (Polymarket CLOB) — Implementation Notes

This document captures the decisions/answers for implementing the **Polymarket CLOB “User Channel” WebSocket** in your live trading mode (Step 8 of your plan).

---

## 1) WebSocket Endpoint & Auth

### User channel URL
Use:

- `wss://ws-subscriptions-clob.polymarket.com/ws/user`

Docs:
- User channel: https://polymarket-292d1b1b.mintlify.app/developers/CLOB/websocket/user-channel

### Authentication method
Auth is **not** via HTTP headers on the WS upgrade. You authenticate **after connecting** by sending a **subscribe message** that includes an `auth` object (API key/secret/passphrase).

Docs:
- WSS quickstart / subscription flow: https://polymarket-292d1b1b.mintlify.app/quickstart/websocket/WSS-Quickstart
- User channel auth + subscription params: https://polymarket-292d1b1b.mintlify.app/developers/CLOB/websocket/user-channel

**Practical implication:** your WS client should:
1. Connect
2. Send subscribe payload containing credentials
3. Treat successful subscription as “authenticated”

---

## 2) Message Format

The user channel emits events for at least:
- **Order updates** (`event_type: "order"`)
- **Trade/fill updates** (`event_type: "trade"`)

### A) Order update messages (`event_type: "order"`)
Used for order placement/updates/cancellation and progress fields like matched size.

Typical payload fields you should expect/use:
- `id` — **CLOB order id**
- `type` — `PLACEMENT` / `UPDATE` / `CANCELLATION`
- `asset_id` — token id
- `market` — condition id
- `price`, `side`
- `original_size`, `size_matched`
- `associate_trades` (optional) — trade ids linked to this order

Docs: https://polymarket-292d1b1b.mintlify.app/developers/CLOB/websocket/user-channel

### B) Trade/fill messages (`event_type: "trade"`)
Used for matched trades and their lifecycle (MATCHED → MINED → CONFIRMED; plus retry/fail statuses).

Typical payload fields you should expect/use:
- `id` — **trade id**
- `status` — lifecycle status
- `asset_id`, `price`, `side`, `size`
- `taker_order_id`
- `maker_orders[]` where each entry includes:
  - `order_id`
  - matched size/amount for that maker order

Docs: https://polymarket-292d1b1b.mintlify.app/developers/CLOB/websocket/user-channel

### TS client websocket support?
Assume you implement the WS client **yourself** (e.g., Node `ws`) and use `@polymarket/clob-client` primarily for:
- REST calls
- signing/auth for placing orders

Repo (REST + signing client): https://github.com/Polymarket/clob-client

---

## 3) Fill Status Lifecycle (MATCHED → MINED → CONFIRMED)

Docs mention trade statuses and progression in the user channel.

Docs: https://polymarket-292d1b1b.mintlify.app/developers/CLOB/websocket/user-channel

### Recommendation (accounting correctness)
- **Create/Upsert a `LiveFill` record on `MATCHED`** (for fast UI feedback).
- **Do NOT write final ledger/accounting entries on `MATCHED`.**
- **Write ledger entries only on `CONFIRMED`.**
- If you receive `FAILED`, mark the `LiveFill` failed and **do not** ledger it.

**Why:** `MATCHED` is optimistic (you want to show it), but `CONFIRMED` is the closest “authoritative” state for money/position accounting.

---

## 4) Order–Fill Linking (and race conditions)

### How to link a fill to your `LiveOrder`
Use CLOB order ids found in trade messages:

- If **your order was taker**: `trade.taker_order_id == LiveOrder.clobOrderId`
- If **your order was maker**: any `trade.maker_orders[i].order_id == LiveOrder.clobOrderId`

Docs: https://polymarket-292d1b1b.mintlify.app/developers/CLOB/websocket/user-channel

**Secondary linkage (optional):**
- Order messages may contain `associate_trades` for additional linking.

### Can fills arrive before you stored `clobOrderId`?
Yes, it can happen (WS is fast, DB writes aren’t instant). Build a robust “orphan trade” path.

**Robust approach: orphan buffer**
- Maintain an **in-memory buffer** keyed by `order_id` and/or `trade_id`
- If a trade arrives and no `LiveOrder` is found yet:
  - store it temporarily (e.g., 10–30s TTL)
  - retry lookup after the placement response is persisted
- Once the `LiveOrder` appears, drain/process buffered trades

This avoids fragile matching by price/size/time and keeps accounting consistent.

---

## 5) External Fills (not caused by your bot)

### Should you store them?
**Yes.**

If a fill event arrives for your live wallet that **doesn’t map to any `LiveOrder`**, store it as:
- `LiveFill.origin = EXTERNAL`

### Should external fills write ledger entries?
**Yes,** if your goal is that “Real Portfolio” stays accurate.

Otherwise your displayed balances/positions will drift from reality whenever:
- you trade manually
- another automation trades
- an old order fills later
- you take an action outside the bot

**UI/ops note:** clearly flag “EXTERNAL” in the dashboard so you can audit unexpected wallet movements quickly.

---

## Suggested Implementation Checklist (short)

1. WS connect to `/ws/user`
2. Send subscribe/auth payload (post-connect)
3. Handle:
   - `event_type: "order"` → update LiveOrder status + matched sizes
   - `event_type: "trade"` → upsert LiveFill
4. Use maker/taker order-id matching to link fills to orders
5. Buffer “orphan fills” briefly if you can’t find the order yet
6. Ledger:
   - create/update LiveFill at MATCHED
   - finalize ledger only at CONFIRMED
7. Persist external fills and ledger them as external-origin changes

---

## Source links
- User channel: https://polymarket-292d1b1b.mintlify.app/developers/CLOB/websocket/user-channel
- WebSocket quickstart: https://polymarket-292d1b1b.mintlify.app/quickstart/websocket/WSS-Quickstart
- TS client repo: https://github.com/Polymarket/clob-client
