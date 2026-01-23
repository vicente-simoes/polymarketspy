# Budgeted Dynamic — Implementation Steps

This document turns `budgeted_dynamic.md` into an exact, no-open-decisions implementation plan for this repo. After completing every step (including tests + manual QA), **Budgeted Dynamic** is implemented and verifiably working.

---

## Definition of Success (DoD)

1. **No behavior change** when Budgeted Dynamic is disabled (default).
2. When enabled, each followed user can run either:
   - **Fixed Rate** sizing (current behavior), or
   - **Budgeted Dynamic** sizing where `r_u = clamp(B_u / E_u, r_min, r_max)`.
3. **Hard budget enforcement** (optional but supported) prevents a leader from pushing your attributed exposure above their budget; it caps or skips with clear reason codes.
4. Dashboard shows, per leader: configured budget `B_u`, leader exposure `E_u`, computed `r_u`, and (if HARD) budget headroom + utilization.
5. Unit tests cover dynamic sizing + hard/soft enforcement edge cases, and all worker tests pass.

---

## Repo-Specific Mapping (terminology → code)

- “Leader *u*” → `FollowedUser.id` / `followedUserId` throughout worker + web.
- Your per-leader budget `B_u` (USDC) → stored in `CopySizingConfig.configJson` as `budgetUsdcMicros` (integer micros).
- Leader exposure `E_u` (USDC) → **shadow portfolio exposure**:
  - `PortfolioSnapshot` row with `portfolioScope = SHADOW_USER` and `followedUserId = u`.
  - Use `exposureMicros` as `E_u` (absolute mark-to-market exposure).
- Your current exposure attributed to leader `u` → **exec portfolio exposure by user**:
  - Prefer live computation already done in `apps/worker/src/simulate/executor.ts` via `getPortfolioState(...).exposureByUser.get(u)`.
  - The dashboard uses `PortfolioSnapshot` for `portfolioScope = EXEC_GLOBAL` and `followedUserId = u`.
- “Fixed rate” today → `Sizing.copyPctNotionalBps` (bps of their notional) in `packages/shared/src/config.ts`.

---

## Locked Design Decisions (no macro decisions left)

### Config storage + inheritance

- Store all Budgeted Dynamic knobs inside the existing `CopySizingConfig.configJson` JSON blob (no new DB tables).
- **Global-only kill switch:** `budgetedDynamicEnabled` is read **only from GLOBAL config** and cannot be overridden per-user (even if a per-user JSON contains it).
- Inheritance is “JSON key absent”:
  - GLOBAL `CopySizingConfig` sets defaults.
  - USER `CopySizingConfig` optionally overrides individual keys; missing keys inherit.

### Config keys (exact)

Add the following keys to `SizingSchema` (all optional in DB payloads, defaulted by schema):

- `sizingMode`: `"fixedRate"` | `"budgetedDynamic"`
- `budgetedDynamicEnabled`: boolean (GLOBAL-only kill switch)
- `budgetUsdcMicros`: number (integer, ≥ 0)
- `budgetRMinBps`: number (integer, ≥ 0) — min clamp for `r_u` expressed in bps
- `budgetRMaxBps`: number (integer, ≥ 0) — max clamp for `r_u` expressed in bps
- `budgetEnforcement`: `"hard"` | `"soft"`
- `minLeaderTradeNotionalMicros`: number (integer, ≥ 0) — filter on *leader* notional per trade-group

### Exposure source for `E_u`

- Primary: latest `PortfolioSnapshot` (`SHADOW_USER`, `followedUserId=u`) `exposureMicros`.
- Fallback (for missing/very stale snapshots): treat `E_u = 0` and log a warning; in this case compute `r_u = r_max` to avoid division-by-zero and keep behavior bounded.

### Small-trade buffering compatibility (required)

This repo’s small-trade buffering currently buffers **already-scaled copy notional**. To make Budgeted Dynamic and buffering compatible, treat buffered groups as **“raw target notional”** at execution time and **do not apply copy% again**.

Concretely:
- For `sourceType === "BUFFER"`, interpret `TradeEventGroup.totalNotionalMicros` as **raw copy notional**.
- For `sourceType !== "BUFFER"`, interpret `TradeEventGroup.totalNotionalMicros` as **leader notional** (current meaning).

---

## Phase 1 — Shared Types + Schemas

### 1.1 Add enums/constants to shared config

Files:
- `packages/shared/src/config.ts`
- `packages/shared/src/index.ts`

Steps:
1. Add `SizingMode` constant + `SizingModeType`:
   - `"fixedRate"`, `"budgetedDynamic"`.
2. Add `BudgetEnforcement` constant + `BudgetEnforcementType`:
   - `"hard"`, `"soft"`.
3. Extend `SizingSchema` with the keys listed above, including safe defaults:
   - Default `budgetedDynamicEnabled: false`
   - Default `sizingMode: "fixedRate"`
   - Default `budgetUsdcMicros: 0`
   - Default `budgetRMinBps: 0`
   - Default `budgetRMaxBps: 100` (1.00%) to match current default copy rate ceiling
   - Default `budgetEnforcement: "hard"`
   - Default `minLeaderTradeNotionalMicros: 0` (disabled)
4. Add a `refine` so `budgetRMinBps <= budgetRMaxBps` (reject invalid config).

Deliverable:
- `@copybot/shared` exports the new enums/types and `SizingSchema` parses both old and new configs.

---

## Phase 2 — Worker: Config Loading + Defaults

Files:
- `apps/worker/src/simulate/config.ts`

Steps:
1. Extend `DEFAULT_SIZING` to include the new keys with the exact defaults from Phase 1.
2. Keep the existing parse/merge pattern, but prevent per-user override of the global kill switch:
   - In `loadUserConfig()`, drop `budgetedDynamicEnabled` from the parsed per-user sizing payload before merging.

Deliverable:
- Worker can load global + per-user sizing with new fields, and global kill switch always wins.

---

## Phase 3 — Worker: Budgeted Dynamic Sizing (core math)

Files:
- `apps/worker/src/simulate/sizing.ts`

Steps:
1. Add a pure helper:
   - `computeBudgetedDynamicRawTargetMicros(theirNotionalMicros, budgetUsdcMicros, leaderExposureMicros, rMinBps, rMaxBps)`.
   - Semantics:
     - If `leaderExposureMicros <= 0`: treat rate as `rMaxBps`.
     - Else `raw = floor(theirNotionalMicros * budgetUsdcMicros / leaderExposureMicros)`.
     - Clamp *by rate* using:
       - `minTarget = floor(theirNotionalMicros * rMinBps / 10000)`
       - `maxTarget = floor(theirNotionalMicros * rMaxBps / 10000)`
       - `raw = clamp(raw, minTarget, maxTarget)`
2. Refactor existing sizing logic so clamps can be applied to an already-computed raw target:
   - Extract “apply min/max/bankroll clamps” into a function like:
     - `applyTradeSizingClamps(rawTargetMicros, bankrollEquityMicros, sizing)`.
   - Keep existing behavior for fixed mode exactly (including min clamp behavior).
3. Add a helper that computes “raw target notional” for non-buffer groups:
   - If Budgeted Dynamic disabled OR `sizingMode === "fixedRate"` → use existing fixed-rate formula.
   - If enabled + `sizingMode === "budgetedDynamic"` → use `computeBudgetedDynamicRawTargetMicros(...)`.

Deliverable:
- A single place (`sizing.ts`) computes raw targets for both sizing modes, with deterministic integer math.

---

## Phase 4 — Worker: Execution Path (budgeted dynamic + enforcement)

Files:
- `apps/worker/src/simulate/executor.ts`
- `packages/shared/src/reasonCodes.ts`

### 4.1 Reason codes (exact)

Add to `packages/shared/src/reasonCodes.ts`:
- `LEADER_TRADE_BELOW_MIN_NOTIONAL` — group is filtered by `minLeaderTradeNotionalMicros`.
- `BUDGET_HARD_CAP_EXCEEDED` — HARD enforcement blocks/caps below minimum executable size.

### 4.2 Apply `minLeaderTradeNotionalMicros`

In `executeTradeGroup()`:
1. Before sizing, if `options.sourceType !== "BUFFER"` and
   - `sizing.minLeaderTradeNotionalMicros > 0` and
   - `group.totalNotionalMicros < sizing.minLeaderTradeNotionalMicros`,
   then SKIP with reason `LEADER_TRADE_BELOW_MIN_NOTIONAL`.
2. Ensure the SKIP path still writes a `CopyAttempt` row as usual (so it shows in dashboard).

### 4.3 Compute target notional with buffer awareness

In `executeTradeGroup()`:
1. Determine `rawTargetMicros`:
   - If `options.sourceType === "BUFFER"`:
     - `rawTargetMicros = group.totalNotionalMicros` (already a raw copy target).
   - Else:
     - If Budgeted Dynamic mode is active:
       - Load `leaderExposureMicros` from latest `PortfolioSnapshot` (`SHADOW_USER`, `followedUserId`) and compute via `computeBudgetedDynamicRawTargetMicros(...)`.
     - Otherwise compute fixed-rate raw target.
2. Apply trade sizing clamps with `applyTradeSizingClamps(rawTargetMicros, equityMicros, sizing)`.

### 4.4 Apply budget enforcement (HARD + SOFT)

In `executeTradeGroup()` after you have:
- `portfolioState` (includes `exposureByUser`)
- `targetNotionalMicros` (post min/max/bankroll clamps)

Steps:
1. If Budgeted Dynamic is **not** active → skip this entire section.
2. If `budgetEnforcement === "SOFT"` → skip this entire section.
3. Compute current exposure attributed to leader `u`:
   - `currentExposureMicros = portfolioState.exposureByUser.get(followedUserId) ?? 0n`
4. If trade is **reducing exposure** (`isReducingExposure(...) === true`) → do not enforce caps.
5. Else (increasing exposure):
   - `budgetMicros = BigInt(sizing.budgetUsdcMicros)`
   - `headroom = budgetMicros - currentExposureMicros`
   - If `headroom <= 0` → SKIP with `BUDGET_HARD_CAP_EXCEEDED`
   - Else `cappedTarget = min(targetNotionalMicros, headroom)`
   - If `cappedTarget < BigInt(sizing.minTradeNotionalMicros)` → SKIP with `BUDGET_HARD_CAP_EXCEEDED`
   - Else use `cappedTarget` for the rest of execution.

### 4.5 Logging (required observability)

In the executor decision log, include:
- `sizingMode`, `budgetedDynamicEnabled`, `budgetEnforcement`
- `budgetUsdcMicros`, `leaderExposureMicros` (when dynamic)
- computed `r_u` (as a float for logs only, derived from `budget/exposure` with 0-safe handling)
- `currentExposureMicros`, `headroomMicros`, and whether target was capped

Deliverable:
- Non-buffer trades size dynamically when enabled.
- Buffer trades do not get double-scaled.
- HARD enforcement caps/skips as specified, with reason codes.

---

## Phase 5 — Worker: Small-Trade Buffering Integration (dynamic raw sizing)

Files:
- `apps/worker/src/simulate/processor.ts`

Steps:
1. When buffering is enabled (`smallTradeBuffering.enabled === true`), load **per-user effective config**:
   - replace `getGlobalConfig()` with `getUserConfig(followedUserId)` for sizing.
2. Compute `rawCopyNotional` using the same “raw target” logic as Phase 3:
   - If Budgeted Dynamic active → use `computeBudgetedDynamicRawTargetMicros(...)` (leader exposure from snapshots).
   - Else fixed-rate formula (existing).
3. Keep using `rawCopyNotional` for buffering threshold decisions and bucket accumulation (as today).

Deliverable:
- When both Budgeted Dynamic and buffering are enabled, buffered trades reflect dynamic sizing instead of fixed sizing.

---

## Phase 6 — Web: Configuration UI (global + per-user)

Files:
- `apps/web/src/app/config/page.tsx`
- `apps/web/src/app/api/config/global/route.ts` (no logic change; just stores JSON)
- `apps/web/src/app/api/config/user/[id]/route.ts` (no logic change; just stores JSON)

### 6.1 Update global sizing UI (exact fields)

Add to the **Global Sizing** section:
- Toggle: `budgetedDynamicEnabled` (kill switch)
- Select: `sizingMode` default (`fixedRate` | `budgetedDynamic`)
- Inputs:
  - `budgetUsdcMicros` shown as “Budget (USDC)” (USD input)
  - `budgetRMinBps` shown as “r_min (%)”
  - `budgetRMaxBps` shown as “r_max (%)”
  - `minLeaderTradeNotionalMicros` shown as “Min leader trade ($)”
- Select: `budgetEnforcement` (`hard` | `soft`)

Validation rules enforced in the UI before POST:
- If `budgetedDynamicEnabled === false`: allow any values (they’re inert).
- If enabled and `sizingMode === "budgetedDynamic"`:
  - require `budgetUsdcMicros > 0`
  - require `budgetRMinBps <= budgetRMaxBps`

### 6.2 Update per-user sizing UI (inherit-friendly)

Add to the **User Override** sizing section:
- Select (inherit-friendly): `sizingMode` override:
  - `""` (inherit), `fixedRate`, `budgetedDynamic`
- Inherit-friendly overrides for:
  - budget (USD)
  - r_min (%)
  - r_max (%)
  - enforcement (`""` inherit, `hard`, `soft`)
  - min leader trade ($)

Implementation detail:
- For inherit, omit the key from the payload (keep the “key absent means inherit” rule).

Deliverable:
- You can configure Budgeted Dynamic globally and override per user without editing DB by hand.

---

## Phase 7 — Web: Budget/Exposure Observability (dashboard)

Files:
- `apps/web/src/app/api/users/[id]/route.ts`
- `apps/web/src/app/users/[id]/page.tsx`
- (new) `apps/web/src/app/api/budgeted-dynamic/summary/route.ts`
- (optional UI) `apps/web/src/app/config/page.tsx`

Steps:
1. Add a new API endpoint `GET /api/budgeted-dynamic/summary` that returns, for each enabled followed user:
   - user: `id`, `label`
   - effective config: `sizingMode`, `budgetUsdc`, `budgetEnforcement`, `rMin`, `rMax`
   - `leaderExposureUsdc` (latest `SHADOW_USER` snapshot exposure)
   - `execExposureUsdc` (latest `EXEC_GLOBAL` snapshot exposure by that user)
   - computed `r_u` and `budgetHeadroomUsdc`
   - utilization `%` (if budget > 0)
2. Render this as a simple table on `/config` below sizing controls (or add a small section to the user detail page).
3. On `/users/[id]`, add MetricTiles:
   - “Leader exposure (E_u)”
   - “Budget (B_u)”
   - “Computed copy rate (r_u)”
   - “Budget headroom” + “Utilization” (when HARD)

Deliverable:
- Operators can see budgets, exposures, and the computed copy rates without guessing.

---

## Phase 8 — Tests (must pass)

Files to add:
- `apps/worker/src/simulate/sizing.budgetedDynamic.test.ts` (new)

Test cases (exact):
1. **Fixed-rate regression:** with `budgetedDynamicEnabled=false`, the computed raw+clamped target equals the pre-change output for representative inputs.
2. **Dynamic rate math:**
   - `E_u = 100_000`, `B_u = 40` → `r_u = 4 bps`, raw target matches `N_leader * 0.0004`.
   - `E_u = 0` → uses `r_max`.
   - `r_min` and `r_max` clamps bound the raw target.
3. **HARD enforcement:**
   - headroom <= 0 → SKIP with `BUDGET_HARD_CAP_EXCEEDED`
   - headroom between 0 and target → target is capped to headroom
   - headroom < minTradeNotional → SKIP with `BUDGET_HARD_CAP_EXCEEDED`
4. **Reducing exposure bypass:** budget cap is not applied when `isReducingExposure(...)` is true (mock the helper or isolate the cap logic into a pure function and unit test it).

Commands:
- `pnpm -C apps/worker test`
- `pnpm -C apps/worker typecheck`
- `pnpm -C apps/web typecheck`

---

## Phase 9 — Manual QA (paper mode)

Prereqs (from `runbook.md`):
- Start DB + Redis via Docker (`docker/docker-compose.dev.yml`).
- Run `pnpm dev` (web + worker).

Steps:
1. Confirm baseline:
   - `budgetedDynamicEnabled=false` and `sizingMode=fixedRate`
   - verify copy attempts match existing sizing behavior.
2. Enable Budgeted Dynamic globally but keep default mode fixed:
   - set `budgetedDynamicEnabled=true`, `sizingMode=fixedRate`
   - confirm behavior unchanged.
3. Turn on Budgeted Dynamic for a single leader:
   - per-user `sizingMode=budgetedDynamic`
   - set `budgetUsdc` and `budgetEnforcement=hard`
4. Validate:
   - `/config` summary shows `B_u`, `E_u`, `r_u`, headroom.
   - Copy attempts for that leader show smaller `targetNotional` as `E_u` grows.
   - When exec exposure nears budget, new increasing-exposure attempts are capped or SKIP with `BUDGET_HARD_CAP_EXCEEDED`.
5. Toggle HARD→SOFT and confirm that sizing still uses `r_u` but no hard cap is applied.

---

## Phase 10 — Rollout

1. Deploy with `budgetedDynamicEnabled=false` by default.
2. Enable per-user first (whale only) and monitor:
   - skip reasons distribution
   - headroom utilization
   - whether min/max clamps bind frequently (tune configs).

