# Step 13 — Testing & Verification

This checklist mirrors `live_trading_steps.md` §13.

---

## 13.1 Worker unit tests

Run:
- `pnpm --filter @copybot/worker test`
- `pnpm --filter @copybot/worker typecheck`

Coverage added for the MVP requirements:
- idempotency key determinism (`apps/worker/src/trading/idempotency.test.ts`)
- tick/step rounding + post-rounding marketability (`apps/worker/src/live/orderMath.test.ts`)
- shrink-to-affordable / shrink-to-available (`apps/worker/src/live/orderMath.test.ts`)
- reservation accounting + pause gating (`apps/worker/src/live/accountState.test.ts`)

---

## 13.2 Integration smoke test (dev)

Prereqs:
- DB + Redis running (see `runbook.md`).
- Worker has live secrets configured (Polymarket CLOB auth) **if** you want to actually place a live order.
- At least one followed user enabled, and not `liveOverride=FORCE_OFF`.

Checklist:
1) **Live disabled**: set `system:config.liveTradingEnabled=false`.
   - Expect: no live orders placed; Live Trades shows global OFF.
2) **Enable live with tiny limits**:
   - Set `system:config.liveTradingEnabled=true`.
   - In `/config`, switch to **Live** mode and set conservative sizing caps (e.g. very small `maxTradeNotionalUsd`).
3) **Place one small order** (trigger a leader trade event you’d normally copy).
   - Expect: `/live-trades` shows a `LiveOrder` row, a `clobOrderId`, and (eventually) fills.
4) **Force a timeout** (simulate network issues):
   - Expect: `LiveOrder.status=SUBMISSION_UNKNOWN`, submissions pause, and `/live-trades` shows the pause/unknown count.
5) **Recover**:
   - Restore connectivity; wait for reconciliation to resolve or mark FAILED; confirm submissions resume.

Notes:
- Use `/config` → “Execution Controls” to toggle `liveTradingEnabled` / `liveTradingReadOnlyEnabled` / `paperTradingEnabled` / `copyEngineEnabled`.

---

## 13.3 UI acceptance

- Paper pages unchanged and still populate:
  - `/paper-trades`
  - `/paper-portfolio`
- Live Trades operational dashboard populates:
  - `/live-trades` shows orders/fills/skips with reason codes and WS/REST indicators
- Real Portfolio populates:
  - `/real-portfolio` shows “PnL since baseline <time>”, last reconcile time, diff indicator, and mark-priced positions
