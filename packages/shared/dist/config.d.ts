import { z } from "zod";
/**
 * Guardrails configuration schema.
 * All values use basis points (bps) or micros for precision.
 * 1 bps = 0.01%, 1 micro = $0.000001
 */
export declare const GuardrailsSchema: z.ZodObject<{
    /** Max worsening vs their fill price in micros (default: 10000 = $0.01) */
    maxWorseningVsTheirFillMicros: z.ZodDefault<z.ZodNumber>;
    /**
     * Optional max BUY cost per share in micros (e.g. 970_000 = $0.97).
     * If set, BUY trades with simulated VWAP >= this value are skipped.
     */
    maxBuyCostPerShareMicros: z.ZodOptional<z.ZodNumber>;
    /** Max amount over mid price in micros (default: 15000 = $0.015) */
    maxOverMidMicros: z.ZodDefault<z.ZodNumber>;
    /** Max spread in micros to execute (default: 20000 = $0.02) */
    maxSpreadMicros: z.ZodDefault<z.ZodNumber>;
    /** Min depth multiplier in bps (default: 12500 = 1.25x) */
    minDepthMultiplierBps: z.ZodDefault<z.ZodNumber>;
    /** No new opens within X minutes of market close (default: 30) */
    noNewOpensWithinMinutesToClose: z.ZodDefault<z.ZodNumber>;
    /** Artificial latency before decision in ms (default: 750) */
    decisionLatencyMs: z.ZodDefault<z.ZodNumber>;
    /** Max jitter added to latency in ms (default: 250) */
    jitterMsMax: z.ZodDefault<z.ZodNumber>;
    /** Max total exposure as % of equity (default: 7000 = 70%) */
    maxTotalExposureBps: z.ZodDefault<z.ZodNumber>;
    /** Max exposure per market as % of equity (default: 500 = 5%) */
    maxExposurePerMarketBps: z.ZodDefault<z.ZodNumber>;
    /** Max exposure per followed user as % of equity (default: 2000 = 20%) */
    maxExposurePerUserBps: z.ZodDefault<z.ZodNumber>;
    /** Daily loss limit (default: 300 = 3%) */
    dailyLossLimitBps: z.ZodDefault<z.ZodNumber>;
    /** Weekly loss limit (default: 800 = 8%) */
    weeklyLossLimitBps: z.ZodDefault<z.ZodNumber>;
    /** Max drawdown limit (default: 1200 = 12%) */
    maxDrawdownLimitBps: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    maxWorseningVsTheirFillMicros: number;
    maxOverMidMicros: number;
    maxSpreadMicros: number;
    minDepthMultiplierBps: number;
    noNewOpensWithinMinutesToClose: number;
    decisionLatencyMs: number;
    jitterMsMax: number;
    maxTotalExposureBps: number;
    maxExposurePerMarketBps: number;
    maxExposurePerUserBps: number;
    dailyLossLimitBps: number;
    weeklyLossLimitBps: number;
    maxDrawdownLimitBps: number;
    maxBuyCostPerShareMicros?: number | undefined;
}, {
    maxWorseningVsTheirFillMicros?: number | undefined;
    maxBuyCostPerShareMicros?: number | undefined;
    maxOverMidMicros?: number | undefined;
    maxSpreadMicros?: number | undefined;
    minDepthMultiplierBps?: number | undefined;
    noNewOpensWithinMinutesToClose?: number | undefined;
    decisionLatencyMs?: number | undefined;
    jitterMsMax?: number | undefined;
    maxTotalExposureBps?: number | undefined;
    maxExposurePerMarketBps?: number | undefined;
    maxExposurePerUserBps?: number | undefined;
    dailyLossLimitBps?: number | undefined;
    weeklyLossLimitBps?: number | undefined;
    maxDrawdownLimitBps?: number | undefined;
}>;
export type Guardrails = z.infer<typeof GuardrailsSchema>;
/**
 * Copy sizing configuration schema.
 * Controls how much to copy from each trade.
 */
export declare const SizingSchema: z.ZodObject<{
    /** Copy percentage of their notional in bps (default: 100 = 1%) */
    copyPctNotionalBps: z.ZodDefault<z.ZodNumber>;
    /** Minimum trade notional in micros (default: 5_000_000 = $5) */
    minTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /** Maximum trade notional in micros (default: 250_000_000 = $250) */
    maxTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /** Max trade as % of bankroll in bps (default: 75 = 0.75%) */
    maxTradeBankrollBps: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    copyPctNotionalBps: number;
    minTradeNotionalMicros: number;
    maxTradeNotionalMicros: number;
    maxTradeBankrollBps: number;
}, {
    copyPctNotionalBps?: number | undefined;
    minTradeNotionalMicros?: number | undefined;
    maxTradeNotionalMicros?: number | undefined;
    maxTradeBankrollBps?: number | undefined;
}>;
export type Sizing = z.infer<typeof SizingSchema>;
/**
 * System configuration schema.
 */
export declare const SystemConfigSchema: z.ZodObject<{
    /** Whether copy engine is enabled */
    copyEngineEnabled: z.ZodDefault<z.ZodBoolean>;
    /** Aggregation window in ms (default: 2000) */
    aggregationWindowMs: z.ZodDefault<z.ZodNumber>;
    /** Polling interval for Polymarket API in ms (default: 30000) */
    pollingIntervalMs: z.ZodDefault<z.ZodNumber>;
    /** Backfill window on startup in minutes (default: 15) */
    backfillMinutes: z.ZodDefault<z.ZodNumber>;
    /** Initial paper trading bankroll in micros (default: 10000_000_000 = $10,000) */
    initialBankrollMicros: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    copyEngineEnabled: boolean;
    aggregationWindowMs: number;
    pollingIntervalMs: number;
    backfillMinutes: number;
    initialBankrollMicros: number;
}, {
    copyEngineEnabled?: boolean | undefined;
    aggregationWindowMs?: number | undefined;
    pollingIntervalMs?: number | undefined;
    backfillMinutes?: number | undefined;
    initialBankrollMicros?: number | undefined;
}>;
export type SystemConfig = z.infer<typeof SystemConfigSchema>;
/**
 * Netting mode for small trade buffering.
 * - sameSideOnly: Buffer only same-side trades; opposite side flushes current bucket
 * - netBuySell: Allow buys and sells to net within the same bucket (advanced)
 */
export declare const SmallTradeNettingMode: {
    readonly SAME_SIDE_ONLY: "sameSideOnly";
    readonly NET_BUY_SELL: "netBuySell";
};
export type SmallTradeNettingModeType = (typeof SmallTradeNettingMode)[keyof typeof SmallTradeNettingMode];
/**
 * Small trade buffering configuration schema.
 * When enabled, buffers tiny copy trades and flushes them in batches.
 * This reduces distortion from per-trade minimums and improves live execution.
 *
 * All monetary thresholds are in micros (6 decimal places).
 */
export declare const SmallTradeBufferingSchema: z.ZodObject<{
    /** Whether small trade buffering is enabled (default: false) */
    enabled: z.ZodDefault<z.ZodBoolean>;
    /**
     * Trades with copy notional below this threshold are considered "small" and buffered.
     * Default: 250_000 = $0.25
     */
    notionalThresholdMicros: z.ZodDefault<z.ZodNumber>;
    /**
     * Minimum accumulated notional to trigger a flush.
     * Default: 500_000 = $0.50
     */
    flushMinNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /**
     * Hard minimum notional to actually submit an order on flush.
     * If buffered notional < this on flush, skip (don't submit order).
     * Default: 100_000 = $0.10
     */
    minExecNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /**
     * Maximum time a bucket can exist before being flushed (ms).
     * Default: 2500ms
     */
    maxBufferMs: z.ZodDefault<z.ZodNumber>;
    /**
     * If no new trades arrive for this duration, flush early (ms).
     * Only flushes if accumulated >= minExecNotionalMicros.
     * Default: 600ms
     */
    quietFlushMs: z.ZodDefault<z.ZodNumber>;
    /**
     * Netting mode: how to handle opposite-side trades in the same bucket.
     * Default: sameSideOnly
     */
    nettingMode: z.ZodDefault<z.ZodEnum<["sameSideOnly", "netBuySell"]>>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    notionalThresholdMicros: number;
    flushMinNotionalMicros: number;
    minExecNotionalMicros: number;
    maxBufferMs: number;
    quietFlushMs: number;
    nettingMode: "sameSideOnly" | "netBuySell";
}, {
    enabled?: boolean | undefined;
    notionalThresholdMicros?: number | undefined;
    flushMinNotionalMicros?: number | undefined;
    minExecNotionalMicros?: number | undefined;
    maxBufferMs?: number | undefined;
    quietFlushMs?: number | undefined;
    nettingMode?: "sameSideOnly" | "netBuySell" | undefined;
}>;
export type SmallTradeBuffering = z.infer<typeof SmallTradeBufferingSchema>;
