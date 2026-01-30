# Live Trading – Implementation Choices (MVP)

This document captures the **final decisions** to unblock implementation of the live trading mode described in your `live_trading_plan.md`.

These choices are designed to:
- Be **safe by default**
- Match the goals of “similar % returns” (subject to slippage/filters/caps)
- Avoid relying on **undocumented / brittle** exchange behaviors
- Keep the system **upgradeable** later

---

## 1) ClientOrderId lookup + constraints

### Decision (MVP)
**Do NOT depend on `clientOrderId` being queryable** on the Polymarket CLOB for order lookup.

### Why
Polymarket’s documented order lifecycle and “get order” flows are centered around the **exchange order id** (e.g., `order_id` / hash), not a client-supplied ID.

### What we do instead
- Treat your internal **`idempotencyKey`** as the *real* dedupe primitive (DB unique constraint).
- On successful submission, persist the returned **`clobOrderId`** (exchange order id) and use *that* for:
  - status lookups
  - reconciliation
  - UI linking / audit trails

### Timeout / unknown submission handling
- If submission times out: mark `SUBMISSION_UNKNOWN`, **do not blind-retry**, and resolve via reconciliation.

### Optional (safe future-proofing)
You may generate/store a `clientOrderId` derived from `idempotencyKey` for debugging, but **do not assume it is searchable**.

**Relevant docs:**
- Orders: Get Order — https://docs.polymarket.com/developers/CLOB/orders/get-order  
- Orders: Create Order — https://docs.polymarket.com/developers/CLOB/orders/create-order

---

## 2) Fetching trading constraints + authoritative portfolio state

### (a) Tick size / min size / step size

#### Decision (MVP)
Use **orderbook metadata** (book + token trading params cache) as the source of truth for:
- `tickSize`
- `minOrderSize`

Assume **share size step = 1 micro-share (1e-6)** unless you observe a real exchange rejection implying a coarser step.

#### Why
This keeps you aligned with what the exchange actively enforces (tick/min), without inventing a “step” constraint prematurely.

#### Notes
- Implement a `TokenTradingParamsCache` keyed by `tokenId`.
- If a “step” rule appears later (via explicit error), upgrade the cache schema to include it.

**Relevant docs:**
- Orders: Create Order — https://docs.polymarket.com/developers/CLOB/orders/create-order

---

### (b) Authoritative positions + cash (USDC / collateral)

#### Decision (MVP)
Use the **official Polymarket TS client** for authenticated wallet/account state where available.
If a specific “positions” method is not available in your client version, pull positions from the **Polymarket Data API** and reconcile against CLOB token IDs.

#### Why
- The TS client is the most supported/authentic source for signed/auth calls.
- Positions/cash must be treated as **exchange-authoritative** for safety.

#### Practical approach
- **Cash:** query via TS client balance/allowance or equivalent account state helpers.
- **Positions:** prefer TS client method; otherwise use Data API positions endpoint (join to token IDs).
- Persist “Real Portfolio” based on exchange truth; keep your internal ledger for attribution/auditing.

**Relevant docs:**
- TS Client L2 methods — https://docs.polymarket.com/developers/CLOB/clients/methods-l2

---

## 3) In-flight reservation model (avoid oversubscription)

### Decision (MVP)
**Serialize live order placement per wallet** (concurrency = 1) and add a **lightweight reservation layer**.

### Why
Even with FAK orders, without reservations you can oversubscribe cash/shares if multiple orders are submitted concurrently.

### Exact MVP rules
1. **Execution worker concurrency = 1** for live submissions (per wallet).
2. Maintain a `LiveAccountStateCache` with:
   - `cashAvailableMicros`
   - `reservedCashMicros`
   - `sharesAvailableMicros[tokenId]`
   - `reservedSharesMicros[tokenId]`
3. On placing an order:
   - reserve before submission
   - release/adjust on fills/cancel events (user-channel) and/or reconciliation
4. Apply “shrink-to-affordable / shrink-to-available” logic and **skip** if order drops below min size.

### Upgrade path (later)
If/when you want higher throughput:
- increase concurrency and move reservations into a persistent store + atomic updates (e.g., DB row locks).

---

## Summary of final choices

- **ClientOrderId:** don’t rely on exchange lookup; use DB idempotency + `clobOrderId`.
- **Tick/min:** take from book metadata; cache; assume size step = 1 micro-share unless proven otherwise.
- **Positions/cash:** TS client first; Data API fallback for positions; exchange truth is authoritative.
- **Reservations:** concurrency=1 + lightweight reservation; evolve later.

---

## Notes on “similar % returns” goal
These decisions preserve the goal **as much as realistically possible**, but live performance can still diverge due to:
- partial fills (FAK)
- slippage/spread
- max price guardrails
- min size/tick constraints
- latency (leader vs you)
- per-user caps / budget allocations / filters

Your reconciliation loop is what keeps the system honest and prevents “phantom PnL”.
