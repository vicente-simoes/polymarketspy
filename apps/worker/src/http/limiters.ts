import Bottleneck from "bottleneck";
import { logger } from "../log/logger.js";

/**
 * Polymarket API rate limiters.
 *
 * We use separate limiters for high-priority (trades/activity) and
 * low-priority (prices) requests. This prevents price refresh from
 * blocking trade detection.
 *
 * Combined capacity: ~10 rps to stay under Polymarket rate limits.
 * - High priority (trades): 7 rps, burst 10
 * - Low priority (prices): 3 rps, burst 5
 */

/**
 * High-priority limiter for trade/activity ingestion.
 * These requests are time-sensitive for lag detection.
 */
export const polymarketHighPriorityLimiter = new Bottleneck({
    minTime: 140, // ~7 rps
    reservoir: 10, // Burst capacity
    reservoirRefreshAmount: 7,
    reservoirRefreshInterval: 1000,
});

/**
 * Low-priority limiter for price/book fetches.
 * These can be delayed without affecting trade detection.
 */
export const polymarketLowPriorityLimiter = new Bottleneck({
    minTime: 330, // ~3 rps
    reservoir: 5, // Lower burst
    reservoirRefreshAmount: 3,
    reservoirRefreshInterval: 1000,
});

/**
 * Legacy alias for backwards compatibility.
 * Use polymarketHighPriorityLimiter for trades/activity.
 * @deprecated Use polymarketHighPriorityLimiter instead
 */
export const polymarketLimiter = polymarketHighPriorityLimiter;

/**
 * Alchemy fallback RPC limiter.
 * Should rarely be used - most calls go through WebSocket.
 */
export const alchemyFallbackLimiter = new Bottleneck({
    minTime: 200, // 5 rps max
    reservoir: 10,
    reservoirRefreshAmount: 5,
    reservoirRefreshInterval: 1000,
});

/**
 * Gamma API limiter for enrichment.
 * Low priority - enrichment is not time-sensitive.
 * Conservative limits to avoid hitting Gamma rate limits.
 */
export const gammaLimiter = new Bottleneck({
    minTime: 500, // 2 rps max
    reservoir: 5, // Low burst
    reservoirRefreshAmount: 2,
    reservoirRefreshInterval: 1000,
});

// Log when API requests fail (note: "failed" event fires on job errors, not limiter throttling)
polymarketHighPriorityLimiter.on("failed", (error, jobInfo) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
        { error: errorMessage, jobId: jobInfo.options.id, priority: "high" },
        "Polymarket API request failed (high priority)"
    );
});

polymarketLowPriorityLimiter.on("failed", (error, jobInfo) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
        { error: errorMessage, jobId: jobInfo.options.id, priority: "low" },
        "Polymarket API request failed (low priority)"
    );
});

alchemyFallbackLimiter.on("failed", (error, jobInfo) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
        { error: errorMessage, jobId: jobInfo.options.id },
        "Alchemy API request failed"
    );
});

gammaLimiter.on("failed", (error, jobInfo) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
        { error: errorMessage, jobId: jobInfo.options.id },
        "Gamma API request failed"
    );
});
