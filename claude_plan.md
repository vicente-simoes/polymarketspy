# Fast Reconciliation After Alchemy Detection 
## Goal
Reduce trade detection latency from ~30-60 seconds (polling) to ~2-5 seconds (Alchemy-triggered fast fetch) and track latency metrics for v1 real-money readiness.
## Current Problem
- Alchemy WS detects trades in ~1-3 seconds (real-time)
- Jobs are enqueued to `q_reconcile` but **no processor exists**
- Canonical data only arrives via 30-second polling cycle
- No latency metrics are tracked
## Architecture
```
Alchemy WS (1-3s) → q_reconcile → Reconcile Processor (NEW)
                                        ↓
                               Batch events (500ms-1s)
                                        ↓
                               Polymarket API fetch
                                        ↓
                               Insert canonical TradeEvent
                                        ↓
                               Track latency metrics
                                        ↓
                               Existing pipeline continues
```

---

## Files to Create

### 1. `/apps/worker/src/reconcile/processor.ts`
Reconcile worker that consumes `q_reconcile` jobs:
- Handle `alchemy_event`: Fast single-wallet fetch
- Handle `alchemy_reconnect`: Backfill 5 minutes for all users
- Handle `periodic`: Safety net (2 minute backfill)
- Batch events by wallet over 500ms-1s window
- Track latency metrics
 
### 2. `/apps/worker/src/reconcile/batcher.ts`
Batching logic for Alchemy events:
- Buffer events by wallet address
- Debounce: 500ms after last event
- Max wait: 1000ms force flush
- Output: `Map<walletAddress, txHashes[]>`

### 3. `/apps/worker/src/reconcile/latency.ts`
Latency tracking utilities:
- Compute `alchemyLagMs = alchemyDetectTime - eventTime`
- Compute `fetchLagMs = canonicalFetchTime - alchemyDetectTime`
- Compute `totalLagMs = couldCopyTime - eventTime`
- Log individual events at debug level
- Log aggregates (p50, p95) every 60s at info level
 
### 4. `/apps/worker/src/reconcile/index.ts`
Module exports

---

## Files to Modify
 
### 1. `/apps/worker/src/index.ts`
```typescript
// Add import
import { startReconcileWorker, stopReconcileWorker, flushPendingReconciles } from "./reconcile/index.js";

// In main() after startAlchemySubscription():
startReconcileWorker();

// In shutdown():
await flushPendingReconciles();
await stopReconcileWorker();
```

### 2. `/apps/worker/src/alchemy/types.ts`
Extend `ReconcileJobData`:
```typescript
export interface ReconcileJobData {
    reason: "alchemy_event" | "alchemy_reconnect" | "periodic";
    txHash?: string;
    walletAddress?: string;
    blockNumber?: number;      // NEW: for ordering
    backfillMinutes?: number;
    triggeredAt: string;
}
```

### 3. `/apps/worker/src/alchemy/subscription.ts`
Add `blockNumber` to reconcile job data.

### 4. `/apps/worker/src/ingest/trades.ts`
Add single-wallet fast fetch function:
```typescript
export async function ingestTradesForWalletFast(
    walletAddress: string,
    options: { afterTime?: Date; alchemyDetectTime?: Date }
): Promise<{ newCount: number; latencyMs: number }>;
```
 
### 5. `/apps/worker/src/health/server.ts`
Add latency metrics to health output:
```typescript
interface HealthStatus {
    // ... existing
    latencyMetrics?: {
        p50Ms: number;
        p95Ms: number;
        lastEventLagMs: number;
    };
}
```

---

## Batching Strategy

```
Event 1 arrives (wallet X) → Start 500ms timer
Event 2 arrives (wallet X, within 500ms) → Reset timer
Event 3 arrives (wallet X, within 500ms) → Reset timer
... 500ms passes with no new events ...
→ Flush: One API call fetches all trades for wallet X

OR if 1000ms total elapsed → Force flush
```

 Rate limit: Polymarket allows 20 RPS, burst 40. Existing `polymarketLimiter` handles this.

---

## Latency Metrics

| Metric | Formula | Target |
|--------|---------|--------|
| Alchemy lag | `alchemyDetectTime - eventTime` | ~1-3s (Polygon blocks) |
| Fetch lag | `canonicalFetchTime - alchemyDetectTime` | <1s |
| Total lag | `couldCopyTime - eventTime` | <5s for p95 |

Logged at:
- Debug: Each event's metrics
- Info: Aggregate stats every 60s

---

## Implementation Order

1. **Create basic reconcile processor** (no batching first)
   - `processor.ts`, `index.ts`
   - Modify `index.ts` to start worker
   - Verify jobs are consumed

2. **Add batching**
   - `batcher.ts`
   - Integrate into processor

3. **Add latency tracking**
   - `latency.ts`
   - Add logging
   - Add health endpoint metrics

---

## Verification

```bash
# Watch reconcile logs
docker compose logs -f worker | grep -E "(reconcile|latency)"

# Check queue is being consumed
redis-cli LLEN q_reconcile  # Should be 0 or low

# Verify no duplicate trades
psql -c "SELECT source, COUNT(*) FROM \"TradeEvent\" GROUP BY source"

# Check health endpoint latency metrics
curl localhost:8081/health | jq '.latencyMetrics'
```

**Acceptance Criteria:**
- [ ] Total lag < 5 seconds for 95% of events
- [ ] No duplicate TradeEvents from reconcile + polling overlap
- [ ] Polling continues as backup (30s cadence unchanged)
- [ ] Latency metrics visible in health endpoint
