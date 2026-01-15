/**
 * Latency tracking utilities for reconciliation performance metrics.
 *
 * Tracks three key metrics:
 * - alchemyLagMs: Time from event to Alchemy detection
 * - fetchLagMs: Time from Alchemy detection to canonical fetch
 * - totalLagMs: Time from event to "could copy" readiness
 */

import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "latency" });

interface LatencyRecord {
    alchemyLagMs: number;
    fetchLagMs: number;
    totalLagMs: number;
    timestamp: Date;
}

// Sliding window of recent latency records (last 5 minutes)
const WINDOW_SIZE_MS = 5 * 60 * 1000;
const latencyRecords: LatencyRecord[] = [];

// Aggregate stats computed every 60s
let lastAggregateLog = 0;
const AGGREGATE_LOG_INTERVAL_MS = 60_000;

/**
 * Record latency metrics for a single event.
 */
export function recordLatency(params: {
    eventTime: Date;
    alchemyDetectTime: Date;
    canonicalFetchTime: Date;
}): LatencyRecord {
    const { eventTime, alchemyDetectTime, canonicalFetchTime } = params;

    const alchemyLagMs = alchemyDetectTime.getTime() - eventTime.getTime();
    const fetchLagMs = canonicalFetchTime.getTime() - alchemyDetectTime.getTime();
    const totalLagMs = canonicalFetchTime.getTime() - eventTime.getTime();

    const record: LatencyRecord = {
        alchemyLagMs,
        fetchLagMs,
        totalLagMs,
        timestamp: new Date(),
    };

    // Log individual event at debug level
    logger.debug(
        {
            alchemyLagMs,
            fetchLagMs,
            totalLagMs,
            eventTime: eventTime.toISOString(),
        },
        "Latency recorded"
    );

    // Add to sliding window
    latencyRecords.push(record);
    pruneOldRecords();

    // Log aggregates periodically
    maybeLogAggregates();

    return record;
}

/**
 * Remove records older than the window size.
 */
function pruneOldRecords(): void {
    const cutoff = Date.now() - WINDOW_SIZE_MS;
    while (latencyRecords.length > 0 && latencyRecords[0]!.timestamp.getTime() < cutoff) {
        latencyRecords.shift();
    }
}

/**
 * Log aggregate stats every 60 seconds.
 */
function maybeLogAggregates(): void {
    const now = Date.now();
    if (now - lastAggregateLog < AGGREGATE_LOG_INTERVAL_MS) {
        return;
    }
    lastAggregateLog = now;

    const stats = getAggregateStats();
    if (stats.count === 0) {
        return;
    }

    logger.info(
        {
            count: stats.count,
            alchemyLag: { p50: stats.alchemyLag.p50, p95: stats.alchemyLag.p95 },
            fetchLag: { p50: stats.fetchLag.p50, p95: stats.fetchLag.p95 },
            totalLag: { p50: stats.totalLag.p50, p95: stats.totalLag.p95 },
        },
        "Latency aggregates (last 5 min)"
    );
}

/**
 * Compute percentile from sorted array.
 */
function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)]!;
}

export interface LatencyStats {
    p50: number;
    p95: number;
    avg: number;
}

export interface AggregateLatencyStats {
    count: number;
    alchemyLag: LatencyStats;
    fetchLag: LatencyStats;
    totalLag: LatencyStats;
    lastEventLagMs: number | null;
}

/**
 * Get aggregate latency statistics for health endpoint.
 */
export function getAggregateStats(): AggregateLatencyStats {
    pruneOldRecords();

    if (latencyRecords.length === 0) {
        return {
            count: 0,
            alchemyLag: { p50: 0, p95: 0, avg: 0 },
            fetchLag: { p50: 0, p95: 0, avg: 0 },
            totalLag: { p50: 0, p95: 0, avg: 0 },
            lastEventLagMs: null,
        };
    }

    const alchemyLags = latencyRecords.map((r) => r.alchemyLagMs).sort((a, b) => a - b);
    const fetchLags = latencyRecords.map((r) => r.fetchLagMs).sort((a, b) => a - b);
    const totalLags = latencyRecords.map((r) => r.totalLagMs).sort((a, b) => a - b);

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
        count: latencyRecords.length,
        alchemyLag: {
            p50: percentile(alchemyLags, 50),
            p95: percentile(alchemyLags, 95),
            avg: Math.round(avg(alchemyLags)),
        },
        fetchLag: {
            p50: percentile(fetchLags, 50),
            p95: percentile(fetchLags, 95),
            avg: Math.round(avg(fetchLags)),
        },
        totalLag: {
            p50: percentile(totalLags, 50),
            p95: percentile(totalLags, 95),
            avg: Math.round(avg(totalLags)),
        },
        lastEventLagMs: latencyRecords[latencyRecords.length - 1]?.totalLagMs ?? null,
    };
}

/**
 * Reset latency records (for testing).
 */
export function resetLatencyRecords(): void {
    latencyRecords.length = 0;
    lastAggregateLog = 0;
}
