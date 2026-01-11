import Bottleneck from "bottleneck";
import { logger } from "../log/logger.js";

/**
 * Polymarket API rate limiter.
 * Config: ~20 rps sustained, burst up to 40.
 */
export const polymarketLimiter = new Bottleneck({
    minTime: 50, // 20 rps
    reservoir: 40, // Burst capacity
    reservoirRefreshAmount: 20,
    reservoirRefreshInterval: 1000, // Refill 20 tokens per second
});

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

// Log when we're being rate limited
polymarketLimiter.on("failed", (error, jobInfo) => {
    logger.warn({ error, jobId: jobInfo.options.id }, "Polymarket rate limit hit");
});

alchemyFallbackLimiter.on("failed", (error, jobInfo) => {
    logger.warn({ error, jobId: jobInfo.options.id }, "Alchemy rate limit hit");
});
