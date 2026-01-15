/**
 * Reconcile module for fast Alchemy-triggered trade ingestion.
 *
 * Reduces trade detection latency from ~30-60s (polling) to ~2-5s
 * by using Alchemy WebSocket events as triggers for immediate API fetches.
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

export {
    getPendingBatchCount,
    getPendingEventCount,
} from "./batcher.js";
