# budgeted_dynamic.md

## Summary

**Budgeted Dynamic** is a trade sizing mode that lets you follow multiple leaders with **explicit per-leader bankroll allocations** (“budgets”) so that a high-volume / high-exposure leader (“whale”) cannot dominate your portfolio.

It is **purely optional**:
- When **disabled**, your system behaves exactly as it does today (e.g., FIXED_RATE copy % of leader notional).
- When **enabled**, you can turn it on **globally** and/or **per followed user**, with per-user overrides that can **inherit** global defaults.

This feature is designed to preserve “similar return *behavior*” to leaders **subject to safety and feasibility constraints** (min order size, max per-trade caps, liquidity, price limits, and budget caps). It does **not** guarantee identical trade-by-trade replication.

---

## Goals

1. **Prevent portfolio domination** by a leader with massive exposure or trade sizes.
2. Allow **balanced multi-leader portfolios** using explicit allocations (e.g., $60/$60/$50/$30).
3. Keep behavior stable as leaders’ exposures change (whale grows → your effective copy rate shrinks automatically).
4. Provide clean UX: **toggleable** and compatible with existing per-user overrides and safety rails.
5. Play nicely with small-trade batching/netting (optional; independent feature).

---

## Core Concepts

### Budget (per leader)

- **Bᵤ**: Your budget allocated to leader *u* (USDC).
- Think of it as “how much of my bankroll this leader is allowed to control.”

Budgets can be configured:
- **Globally** (default budget policy)
- **Per user** (override budget amount and/or scaling rules)

### Leader exposure

- **Eᵤ**: Leader’s current total exposure (USDC).
- Typically: sum of their open positions’ notional value (or equivalent exposure measure available to you).
- Cash balance is not required; you just need a stable “exposure” proxy.

### Effective copy rate

- **rᵤ**: Effective copy rate for leader *u* (unitless).

In **BUDGETED_DYNAMIC** mode:

> **rᵤ = clamp(Bᵤ / Eᵤ, r_min, r_max)**

This makes the leader’s size self-normalize:
- If whale exposure increases, **rᵤ decreases**.
- If exposure decreases, **rᵤ increases** (but is bounded by `r_max`).

**Example**
- Whale exposure Eᵤ = 100,000; your budget Bᵤ = 40 → rᵤ = 0.0004
- If whale exposure jumps to 300,000 → rᵤ ≈ 0.000133

---

## Modes (toggleable)

### 1) FIXED_RATE (current behavior)
- `target_copy_notional = leader_trade_notional * fixed_rate`
- Good for leaders whose exposure and trading style are similar and stable.

### 2) BUDGETED_DYNAMIC (new)
- Uses **budget + leader exposure** to compute `rᵤ`
- `target_copy_notional = leader_trade_notional * rᵤ`
- Adds (optional) **budget enforcement** to stop a leader from exceeding their allocated footprint.

**Important:** You can apply BUDGETED_DYNAMIC:
- **Globally** (default for all leaders)
- **Per user** (override a specific leader to be budgeted while others remain fixed)

---

## Budget Enforcement (how strictly to obey Bᵤ)

You should support one of these semantics (or both):

### A) Hard budget (recommended for whales)
Leader *u* cannot exceed their budgeted exposure allocation.

- Compute “your current exposure attributed to leader u” (e.g., current value of positions created via that leader’s copy stream).
- If executing a new copy trade would exceed the budget:
  - reduce size to remaining budget headroom, or
  - skip if remaining headroom is below minimum execution size.

This makes the whale safe even during bursts.

### B) Soft budget (optional)
Budget influences sizing via rᵤ, but does not hard-stop further exposure.
- Safer than fixed rate, but still can drift if the leader continuously adds exposure.

---

## Sizing Pipeline (high-level)

For every detected leader trade event:

1. Determine leader u and load effective config (global → per-user override/inherit).
2. Pick sizing mode:
   - FIXED_RATE → rᵤ = fixed_rate
   - BUDGETED_DYNAMIC → rᵤ = clamp(Bᵤ / Eᵤ, r_min, r_max)
3. Compute target copy notional:
   - `N_target = N_leader * rᵤ`
4. Apply safety rails and filters (see next section).
5. If “small trade netting” is enabled AND the trade qualifies as “small,” optionally net/aggregate before execution.
6. Execute (paper or live).

---

## Safety Rails & Filters (why you may not copy every trade)

Even with perfect logic, real trading forces you to skip/cap orders. These are intended and necessary.

### Trade-level caps
- **MAX_EXEC_NOTIONAL_USDC** (absolute per trade)
- **MAX_TRADE_PCT_BANKROLL** (relative per trade)
- **MIN_EXEC_NOTIONAL_USDC** (absolute minimum to avoid fake micro-orders)

### Leader-side filters
- **MIN_LEADER_TRADE_NOTIONAL_USDC**: skip leader trades below this size (especially for whales spamming micro trades).
- **MAX_PRICE_PER_SHARE**: skip markets above a threshold (e.g., > $0.97).
- Optional: market allow/deny lists, min liquidity, max spread, etc.

### Execution feasibility
- Tick sizes / share granularity
- Liquidity and slippage constraints
- Order type constraints (limit-only vs marketable limit)
- Time-in-force behavior
- Queue/backpressure (if your system is overloaded)

**Net effect:** You will often copy “most trades” but not “all trades,” and you may under-copy large spikes if per-trade caps are tight.

---

## Relationship to “Same % return as leader”

### Does BUDGETED_DYNAMIC guarantee the same % return as the leader?
**Not guaranteed.** It targets **similar proportional exposure**, but several things cause divergence:
- You are filtering trades (price caps, min leader notional).
- You are capping trades (max per-trade notional / % bankroll).
- You may miss events due to latency or backpressure.
- Your fills may differ (slippage, partial fills, rejected orders).

### What *is* true when everything is ideal?
If:
- you detect all trades,
- you execute all trades successfully at similar prices,
- your constraints never bind (min/max notional, budget headroom),
then holding ratios **tend to resemble** the leader’s, scaled by rᵤ.

But in practice, treat this as **risk-managed “similarity,” not identity**.

---

## Configuration Surface

### Global toggles
- `SIZING_MODE_DEFAULT`: `FIXED_RATE | BUDGETED_DYNAMIC`
- `FIXED_COPY_RATE_DEFAULT` (used only in FIXED_RATE)
- `BUDGETED_DYNAMIC_ENABLED` (master on/off)
- `BUDGET_R_MIN_DEFAULT` (floor for rᵤ)
- `BUDGET_R_MAX_DEFAULT` (ceiling for rᵤ)
- `BUDGET_ENFORCEMENT_DEFAULT`: `HARD | SOFT`

### Per-user overrides (inherit by default)
For each followed user u:
- `SIZING_MODE_OVERRIDE`: `INHERIT | FIXED_RATE | BUDGETED_DYNAMIC`
- `BUDGET_USDC`: numeric (e.g., 30, 60, 100)
- `BUDGET_R_MIN`, `BUDGET_R_MAX` (optional)
- `BUDGET_ENFORCEMENT`: `INHERIT | HARD | SOFT`

### Filtering & safety (global + per user)
- `MIN_LEADER_TRADE_NOTIONAL_USDC` (especially useful for whales)
- `MIN_EXEC_NOTIONAL_USDC`
- `MAX_EXEC_NOTIONAL_USDC`
- `MAX_TRADE_PCT_BANKROLL`
- `MAX_PRICE_PER_SHARE` (e.g., 0.97)

### Interaction knobs for small trade netting (independent feature)
If you also enabled batching/netting:
- `SMALL_TRADE_NETTING_MODE` (on/off + mode)
- `SMALL_TRADE_MIN_EXEC_NOTIONAL_USDC`
- netting window / grouping rules

**Important:** Budgeted Dynamic does not require netting. Netting simply improves realism and reduces micro-order spam when you *do* allow small trades.

---

## Practical Example: $200 bankroll, 3 small leaders + whale

Budgets:
- Leader A: $60
- Leader B: $60
- Leader C: $50
- Whale: $30

Suggested whale-specific overrides:
- Mode: `BUDGETED_DYNAMIC`
- Budget: `$30–$60` depending on how much you want him to matter
- Min leader trade notional: `$100–$250` (skip tiny spam)
- Min exec notional: `$0.25–$1.00` (avoid unrealistic dust orders)
- Max per trade: `$2–$5` (safety)
- Optional: enable small trade netting with a longer window for the whale (2–5s)

Suggested defaults for smaller leaders:
- Keep FIXED_RATE (e.g. 0.01) if they don’t spam tiny orders
- Consider small-trade netting with a short window (1–2s) if they do

---

## Observability & UX Expectations

To make this feature easy to operate safely, expose:
- The computed **rᵤ** per leader (and the Eᵤ used to compute it)
- The leader’s configured **Bᵤ**
- “Budget headroom” if using HARD enforcement
- Execution outcomes: skipped vs capped vs executed, and why (reason codes)
- A simple dashboard summary:
  - budget allocation by user
  - current exposure by user
  - realized utilization (% of Bᵤ)

This helps you tune budgets and caps without guessing.

---

## Non-goals (things this feature does not promise)

- Identical trade-by-trade replication
- Guaranteed identical % returns
- Removal of the need for min/max trade caps or slippage protection
- Solving market-specific execution issues (liquidity, order rejections, etc.)

---

## TL;DR

**Budgeted Dynamic** gives you a clean, safe way to add a whale (or any extreme trader) without letting their scale dictate yours.

- Toggle it on/off globally or per user.
- Allocate budgets Bᵤ per leader.
- Compute rᵤ from `Bᵤ / Eᵤ`, bounded by r_min/r_max.
- Enforce budgets HARD for whales (recommended).
- Keep existing safety rails (min/max notional, price caps, liquidity rules).
- Expect “similarity under constraints,” not perfect replication.
