/**
 * Reconcile module for safety-net trade ingestion.
 *
 * v0.1 WS-first architecture:
 * - Primary detection: On-chain WS events create canonical trades directly
 * - Reconcile is now a SAFETY NET only (reconnect backfill, periodic catch-up)
 * - Regular polling (30s) also catches any missed trades
 */

export {
    startReconcileWorker,
    stopReconcileWorker,
    flushPendingReconciles,
} from "./processor.js";

export {
    recordLatency,
    getAggregateStats,
    type LatencyStats,
    type AggregateLatencyStats,
} from "./latency.js";
