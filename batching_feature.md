# Small Trade Buffering + Net-Delta Thresholding (Batching) Feature

> **Status:** Design-ready (implementation plan included)  
> **Default:** **OFF** (no behavior change unless enabled in dashboard)  
> **Scope:** Worker-side execution logic + Dashboard configuration UI

---

## 1) Problem this solves

When leader accounts place **many small trades in a row**, naive scaling (e.g., 0.01x) creates two real issues:

1. **Scale distortion from floor/minimums**
   - Example: leader makes 10 trades of $0.45 = $4.50 total.
   - If your system forces each copied trade to at least $0.01 notional, you may copy $0.10 total, which is **not** 0.01x of $4.50 ($0.045). That’s >2x what “true scale” would imply.

2. **Live-trading practicality**
   - Exchanges often impose minimum order size, tick sizes, rounding, fees, and rate limits.
   - Executing tiny orders can be **rejected** or cause execution quality/risk issues.

**This feature batches only tiny trades** into a short-lived buffer and executes a single order once the aggregated “net delta” is meaningful.

---

## 2) Goals and expected results

### Goals
- **G1 — Preserve current behavior when disabled**
  - If the feature toggle is OFF, the system behaves exactly as it does today.
- **G2 — Copy non-small trades immediately**
  - Only trades below a configurable threshold go through buffering.
- **G3 — Make scaling more “true”**
  - Reduce distortion caused by per-trade minimums and rounding.
- **G4 — Improve live reliability**
  - Fewer tiny orders → fewer API rejections and less noisy execution.
- **G5 — Transparent & observable**
  - Clear metrics and logs showing what was buffered, flushed, or skipped.

### Expected results
- Fewer orders placed (especially during leader “bursts”).
- More accurate proportional exposure when leaders split a trade into many small ones.
- Higher live execution success rate (fewer min-size/tick-size failures).
- Lower overhead on order APIs/websockets.

---

## 3) Non-goals

- Perfect replication of leader fill-by-fill sequencing.
- Multi-market portfolio optimization or cross-token netting.
- Replacing your existing risk limits, sizing logic, or execution engine.

This feature sits **between “leader trade detected” and “copy order emitted”**.

---

## 4) Feature behavior (high level)

1. Detect leader trade event (same as today).
2. Compute **your intended copy notional** using existing sizing/weights/risk caps.
3. If buffering is disabled → **execute immediately** (today’s behavior).
4. If buffering is enabled:
   - If `copyNotional >= SMALL_TRADE_NOTIONAL_THRESHOLD_USDC` → **execute immediately**
   - Else → **add to buffer bucket** keyed by (followedUserId, outcomeTokenId, side/netting mode)
5. Bucket flushes when it hits a flush condition (threshold reached or timeouts).
6. On flush, place **one** order representing the bucket’s net delta (with rounding/minimum checks).

---

## 5) Configuration knobs (Dashboard)

> These should exist as **Global defaults** and optionally as **Per-User overrides** later.  
> Start with global first if you want minimal scope.

### Required
- `SMALL_TRADE_BUFFERING_ENABLED` *(boolean, default: false)*
- `SMALL_TRADE_NOTIONAL_THRESHOLD_USDC` *(number, e.g. 0.25)*
  - Trades below this (after scaling + caps) are considered “small” and buffered.
- `SMALL_TRADE_FLUSH_MIN_NOTIONAL_USDC` *(number, e.g. 0.50 or 1.00)*
  - Minimum absolute buffered notional to trigger a flush.
- `SMALL_TRADE_MAX_BUFFER_MS` *(number, e.g. 2500)*
  - Hard deadline; flush (or decide to skip) after this duration from bucket creation.
- `SMALL_TRADE_QUIET_FLUSH_MS` *(number, e.g. 600)*
  - If no new tiny trades arrive for this bucket during the quiet window, flush early (subject to min exec rules).

### Also required (explicitly requested)
- `SMALL_TRADE_NETTING_MODE` *(enum: `sameSideOnly` | `netBuySell`)*
  - `sameSideOnly` (recommended first): bucket holds a single side; if opposite side arrives, flush current bucket and start a new one.
  - `netBuySell` (advanced): allow buys and sells to net within the same bucket window (less churn, more complexity).
- `SMALL_TRADE_MIN_EXEC_NOTIONAL_USDC` *(number, e.g. 0.10–0.50)*
  - **Hard minimum** for actually submitting an order on flush (live safety).
  - If flush occurs but buffered notional < this, do **not** submit an order; log + count as skipped.

---

## 6) What counts as “small” (important detail)

**Smallness is evaluated on your intended copy order, not on leader size.**

Compute copy sizing exactly as you already do:
- base scale (e.g. 0.01)
- user weights / overrides
- bankroll caps
- max trade notional
- any price-per-share guardrails, etc.

Only then decide:
- if `abs(copyNotional) < SMALL_TRADE_NOTIONAL_THRESHOLD_USDC` → buffer
- else → immediate execution

This guarantees: **non-small trades remain immediate**, regardless of the feature being enabled.

---

## 7) Buffer bucket model

### Bucket key
At minimum:
- `followedUserId`
- `outcomeTokenId` (or whatever unique identifier you use for YES/NO token)
- `marketId` (optional if outcome token is globally unique)
- plus netting dimension depending on mode:
  - `sameSideOnly`: include `side` in bucket identity (or store it and enforce)
  - `netBuySell`: a single bucket can carry a signed delta

### Bucket state
- `netNotionalSigned` *(number)*
  - BUY adds +notional, SELL adds -notional (or vice versa as long as consistent).
  - In `sameSideOnly`, this will always be same sign and you enforce no mixing.
- `firstSeenAtMs`
- `lastUpdatedAtMs`
- `countTradesBuffered`
- (optional) `lastReferencePrice` (for better share conversion on flush)

---

## 8) Append logic

When a small trade arrives:

1. Load bucket for `(user, token)` (and possibly side depending on mode).
2. If no bucket → create.
3. If `SMALL_TRADE_NETTING_MODE == sameSideOnly`:
   - If incoming side differs from bucket.side:
     - attempt flush of existing bucket (if executable)
     - then create a new bucket for the new side
4. Add the signed notional to `netNotionalSigned`
5. Update timestamps and counters

---

## 9) Flush conditions

A bucket flushes when **any** of these happens:

1. **Notional threshold reached**  
   `abs(netNotionalSigned) >= SMALL_TRADE_FLUSH_MIN_NOTIONAL_USDC`

2. **Max time reached**  
   `now - firstSeenAt >= SMALL_TRADE_MAX_BUFFER_MS`

3. **Quiet time reached** *(early flush)*  
   `now - lastUpdatedAt >= SMALL_TRADE_QUIET_FLUSH_MS`  
   AND `abs(netNotionalSigned) >= SMALL_TRADE_MIN_EXEC_NOTIONAL_USDC`

### Minimum execution rule (live safety)
When a flush is triggered, before placing an order:
- If `abs(netNotionalSigned) < SMALL_TRADE_MIN_EXEC_NOTIONAL_USDC`:
  - **Skip** (do not submit order)
  - Log + increment `skippedFlushBelowMin`
  - Clear bucket (recommended: clear to prevent stuck buckets)

---

## 10) Execution behavior on flush

When flushing:
1. Determine side:
   - If signed notional > 0 → BUY
   - If signed notional < 0 → SELL
2. Convert notional → shares using your existing pricing/execution rules.
3. Apply rounding and tick sizes as required by the execution venue.
4. Validate:
   - min size
   - min notional
   - acceptable slippage/limit price rules
5. Submit a single order (or enqueue a single copy attempt job).

**Paper mode:** you should enforce the same min rules so paper isn’t lying about live feasibility.

---

## 11) Observability (must-have)

Add to worker health response (and optionally the dashboard):

### State
- `smallTradeBuffering.enabled`
- `smallTradeBuffering.thresholdUsdc`
- `smallTradeBuffering.flushMinUsdc`
- `smallTradeBuffering.minExecUsdc`
- `smallTradeBuffering.nettingMode`
- `smallTradeBuffering.activeBucketsCount`
- `smallTradeBuffering.pendingNotionalTotalUsdc`

### Counters
- `bufferedTrades`
- `immediateTrades`
- `flushedBuckets`
- `flushReason.threshold`
- `flushReason.quiet`
- `flushReason.maxTime`
- `flushReason.oppositeSide` *(sameSideOnly only)*
- `skippedFlushBelowMin`
- `executionFailed` (with reason codes)

### Logging
Log structured entries for:
- bucket create/update
- flush start/end (include reason + size)
- skip due to min
- errors from execution adapter

---

## 12) Step-by-step implementation plan

### Step 1 — Add config model + persistence
Extend your existing config storage (Prisma model(s)) to include:
- `smallTradeBufferingEnabled`
- `smallTradeNotionalThresholdUsdc`
- `smallTradeFlushMinNotionalUsdc`
- `smallTradeMaxBufferMs`
- `smallTradeQuietFlushMs`
- `smallTradeNettingMode`
- `smallTradeMinExecNotionalUsdc`

Run migrations and confirm values can be read by worker and web.

**Acceptance:** worker can read these values and returns them in `/health`.

---

### Step 2 — Dashboard UI (feature toggle + knobs)
Add a “Small Trade Buffering” section:
- Toggle ON/OFF; show numeric fields + dropdown for netting mode.
- When OFF, worker behavior remains unchanged (do not buffer).

**Acceptance:** toggling + saving persists; health reflects new values.

---

### Step 3 — Implement buffering store (in-memory first)
Create a worker module, e.g. `smallTradeBuffer.ts`:
- `getBucket(key)`
- `upsertBucket(key, updateFn)`
- `flushBucket(key, reason)`
- `scanAndFlushDueBuckets()`

Use an in-memory `Map<string, Bucket>` initially.

**Acceptance:** unit tests for bucket state transitions (append, opposite side, netting, flush decisions).

---

### Step 4 — Integrate into trade ingest path
At the point where you currently create a copy attempt:
1. Compute `copyNotional` using existing sizing + risk rules.
2. If buffering disabled → immediate (no changes)
3. If enabled:
   - If `abs(copyNotional) >= threshold` → immediate
   - Else → buffer append

**Critical:** evaluate smallness **after** risk caps so thresholds reflect actual order size.

**Acceptance:** replay a leader burst and confirm fewer copy attempts are created.

---

### Step 5 — Add periodic flush loop
Add a timer (e.g. every 200–500ms) in the worker:
- `scanAndFlushDueBuckets()` checks each bucket and flushes if needed (honoring `MIN_EXEC`).

**Acceptance:** bursts flush into one order; quiet flush works; max-time flush works.

---

### Step 6 — Execution adapter + validation
On flush, route the aggregated order through your existing “place copy trade” code path.
Add validation gates:
- if live mode and order violates min-exec or known minimums → skip + log
- if rounding reduces size below minimum → skip + log

**Acceptance:** no crashes; clear logs; skipped flush is visible.

---

### Step 7 — Metrics & health instrumentation
Wire counters and expose them in health JSON.

**Acceptance:** you can see buffered/flush counters increasing during bursts.

---

### Step 8 (optional, recommended later) — Persist buckets in Redis
If you want resilience across worker restarts or multiple worker replicas:
- Store buckets in Redis with TTL keyed by `(user, token)` and refresh TTL on updates.
- Use a lightweight lock for flush to avoid double-submits in multi-replica.

**Acceptance:** restart worker mid-burst and confirm bucket survives and flushes correctly.

---

## 13) Testing strategy

### Unit tests
- `sameSideOnly`: opposite side flushes current bucket
- `netBuySell`: buy then sell nets to smaller signed notional
- flush thresholds and quiet/max timers
- min-exec skip behavior

### Integration tests (paper)
- Simulate a leader placing 20 small trades:
  - verify 1–3 flushes instead of 20 orders (depending on timing/thresholds)
- Confirm large trades still execute immediately.

### Live rehearsal (small $)
Enable feature with conservative thresholds:
- threshold=0.25, flushMin=1.00, minExec=0.50

Confirm no rejected tiny orders.

---

## 14) Rollout plan

1. Ship behind `SMALL_TRADE_BUFFERING_ENABLED` default OFF.
2. Enable on paper mode only first.
3. Enable on live mode with conservative `MIN_EXEC` + `FLUSH_MIN`.
4. Tune thresholds based on observed trade burst patterns.

---

## 15) Key open questions / TODOs (live venue specifics)

Verify for the live execution adapter you’ll use:
- Minimum order notional / size (if enforced)
- Tick size / price increments
- Any “post-only”, IOC/FOK behavior constraints
- Rate limits (REST + WS)
- Partial fill semantics and cancellation rules

This design deliberately contains a hard gate: `SMALL_TRADE_MIN_EXEC_NOTIONAL_USDC`.

---

## 16) Reference docs (helpful background)

- BullMQ documentation  
  https://docs.bullmq.io/

- Redis eviction policies (`noeviction`)  
  https://redis.io/docs/latest/operate/oss_and_stack/management/eviction/

- Redis persistence (AOF)  
  https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/

- Redis security hardening (`rename-command`)  
  https://redis.io/docs/latest/operate/oss_and_stack/management/security/

---

## 17) Implementation notes (practical guidance)

- Start with `sameSideOnly` first (simpler, safer).
- Keep thresholds conservative in live.
- Make sure **all** behavior changes are gated by the feature toggle.
- Make skipped flushes visible; otherwise you’ll “under-copy” silently.

---

## 18) Quick pseudocode

```ts
function onLeaderTrade(trade) {
  const cfg = loadConfig();
  const copyNotional = computeCopyNotionalWithCaps(trade);

  if (!cfg.smallTradeBufferingEnabled) {
    return executeImmediately(trade, copyNotional);
  }

  if (Math.abs(copyNotional) >= cfg.smallTradeNotionalThresholdUsdc) {
    return executeImmediately(trade, copyNotional);
  }

  bufferAppend({
    userId: trade.userId,
    tokenId: trade.tokenId,
    side: trade.side,
    notionalSigned: trade.side === "BUY" ? +copyNotional : -copyNotional,
  });
}

setInterval(() => {
  for (const bucket of buckets.values()) {
    const reason = flushReason(bucket, cfg, Date.now());
    if (!reason) continue;

    if (Math.abs(bucket.netNotionalSigned) < cfg.smallTradeMinExecNotionalUsdc) {
      metrics.skippedFlushBelowMin++;
      clear(bucket);
      continue;
    }

    flushToExecution(bucket, reason);
    clear(bucket);
  }
}, 250);
