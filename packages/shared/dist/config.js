import { z } from "zod";
/**
 * Guardrails configuration schema.
 * All values use basis points (bps) or micros for precision.
 * 1 bps = 0.01%, 1 micro = $0.000001
 */
export const GuardrailsSchema = z.object({
    // Price protection
    /** Max worsening vs their fill price in micros (default: 10000 = $0.01) */
    maxWorseningVsTheirFillMicros: z.number().int().default(10_000),
    /**
     * Optional max BUY cost per share in micros (e.g. 970_000 = $0.97).
     * If set, BUY trades with simulated VWAP >= this value are skipped.
     */
    maxBuyCostPerShareMicros: z.number().int().min(0).max(1_000_000).optional(),
    /** Max amount over mid price in micros (default: 15000 = $0.015) */
    maxOverMidMicros: z.number().int().default(15_000),
    /** Max spread in micros to execute (default: 20000 = $0.02) */
    maxSpreadMicros: z.number().int().default(20_000),
    /** Min depth multiplier in bps (default: 12500 = 1.25x) */
    minDepthMultiplierBps: z.number().int().default(12_500),
    /** No new opens within X minutes of market close (default: 30) */
    noNewOpensWithinMinutesToClose: z.number().int().default(30),
    // Timing realism
    /** Artificial latency before decision in ms (default: 750) */
    decisionLatencyMs: z.number().int().default(750),
    /** Max jitter added to latency in ms (default: 250) */
    jitterMsMax: z.number().int().default(250),
    // Exposure limits (in basis points of equity)
    /** Max total exposure as % of equity (default: 7000 = 70%) */
    maxTotalExposureBps: z.number().int().default(7000),
    /** Max exposure per market as % of equity (default: 500 = 5%) */
    maxExposurePerMarketBps: z.number().int().default(500),
    /** Max exposure per followed user as % of equity (default: 2000 = 20%) */
    maxExposurePerUserBps: z.number().int().default(2000),
    // Circuit breakers (in basis points)
    /** Daily loss limit (default: 300 = 3%) */
    dailyLossLimitBps: z.number().int().default(300),
    /** Weekly loss limit (default: 800 = 8%) */
    weeklyLossLimitBps: z.number().int().default(800),
    /** Max drawdown limit (default: 1200 = 12%) */
    maxDrawdownLimitBps: z.number().int().default(1200),
});
/**
 * Copy sizing configuration schema.
 * Controls how much to copy from each trade.
 */
export const SizingSchema = z.object({
    /** Copy percentage of their notional in bps (default: 100 = 1%) */
    copyPctNotionalBps: z.number().int().default(100),
    /** Minimum trade notional in micros (default: 5_000_000 = $5) */
    minTradeNotionalMicros: z.number().int().default(5_000_000),
    /** Maximum trade notional in micros (default: 250_000_000 = $250) */
    maxTradeNotionalMicros: z.number().int().default(250_000_000),
    /** Max trade as % of bankroll in bps (default: 75 = 0.75%) */
    maxTradeBankrollBps: z.number().int().default(75),
});
/**
 * System configuration schema.
 */
export const SystemConfigSchema = z.object({
    /** Whether copy engine is enabled */
    copyEngineEnabled: z.boolean().default(true),
    /** Aggregation window in ms (default: 2000) */
    aggregationWindowMs: z.number().int().default(2000),
    /** Polling interval for Polymarket API in ms (default: 30000) */
    pollingIntervalMs: z.number().int().default(30_000),
    /** Backfill window on startup in minutes (default: 15) */
    backfillMinutes: z.number().int().default(15),
    /** Initial paper trading bankroll in micros (default: 10000_000_000 = $10,000) */
    initialBankrollMicros: z.number().int().default(10_000_000_000),
});
