import { z } from "zod";
/**
 * Guardrails configuration schema.
 * All values use basis points (bps) or micros for precision.
 * 1 bps = 0.01%, 1 micro = $0.000001
 */
export declare const GuardrailsSchema: z.ZodObject<{
    /** Max worsening vs their fill price in micros (default: 20000 = $0.02) */
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
    /** No new opens within X minutes of market close (default: 1) */
    noNewOpensWithinMinutesToClose: z.ZodDefault<z.ZodNumber>;
    /** Artificial latency before decision in ms (default: 750) */
    decisionLatencyMs: z.ZodDefault<z.ZodNumber>;
    /** Max jitter added to latency in ms (default: 250) */
    jitterMsMax: z.ZodDefault<z.ZodNumber>;
    /** Max total exposure as % of equity (default: 10000 = 100%) */
    maxTotalExposureBps: z.ZodDefault<z.ZodNumber>;
    /** Max exposure per market as % of equity (default: 10000 = 100%) */
    maxExposurePerMarketBps: z.ZodDefault<z.ZodNumber>;
    /** Max exposure per followed user as % of equity (default: 10000 = 100%) */
    maxExposurePerUserBps: z.ZodDefault<z.ZodNumber>;
    /** Daily loss limit (default: 10000 = 100%) */
    dailyLossLimitBps: z.ZodDefault<z.ZodNumber>;
    /** Weekly loss limit (default: 10000 = 100%) */
    weeklyLossLimitBps: z.ZodDefault<z.ZodNumber>;
    /** Max drawdown limit (default: 10000 = 100%) */
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
 * Live order type for copy trading execution.
 * - FAK: Fill-And-Kill (default) - immediate partials allowed, remainder cancels
 * - FOK: Fill-Or-Kill - all or nothing execution
 * - GTC: Good-Til-Canceled - resting order (not used in MVP)
 */
export declare const LiveOrderType: {
    readonly FAK: "FAK";
    readonly FOK: "FOK";
    readonly GTC: "GTC";
};
export type LiveOrderTypeValue = (typeof LiveOrderType)[keyof typeof LiveOrderType];
/**
 * Live-specific guardrails configuration schema.
 * These extend the base guardrails for live trading mode.
 * All values use basis points (bps) or micros for precision.
 */
export declare const LiveGuardrailsSchema: z.ZodObject<{
    /**
     * Slippage tolerance for BUY orders in bps.
     * Order price = bestAsk * (1 + liveSlippageBpsBuy / 10000)
     * Default: 50 = 0.50%
     */
    liveSlippageBpsBuy: z.ZodDefault<z.ZodNumber>;
    /**
     * Slippage tolerance for SELL orders in bps.
     * Order price = bestBid * (1 - liveSlippageBpsSell / 10000)
     * Can be set higher than BUY to avoid missing exits.
     * Default: 100 = 1.00%
     */
    liveSlippageBpsSell: z.ZodDefault<z.ZodNumber>;
    /**
     * Maximum acceptable book age in ms.
     * If the book is older than this, wait or SKIP.
     * Default: 2000ms
     */
    liveBookFreshnessMs: z.ZodDefault<z.ZodNumber>;
    /**
     * Time to wait for a fresh book before giving up (ms).
     * If WS book is stale, wait this long before SKIP or REST fallback.
     * Default: 500ms
     */
    liveBookWaitMs: z.ZodDefault<z.ZodNumber>;
    /**
     * Default order type for live copy trading.
     * Default: FAK (Fill-And-Kill)
     */
    liveOrderType: z.ZodDefault<z.ZodEnum<["FAK", "FOK", "GTC"]>>;
    /**
     * Whether to use FOK for correction/reconciliation orders.
     * Default: false
     */
    useFokForCorrections: z.ZodDefault<z.ZodBoolean>;
    /**
     * Override maxWorseningVsTheirFillMicros for SELL orders in live mode.
     * Allows more tolerance on exits to avoid missing leader sells.
     * If not set, uses the base guardrail value.
     * Default: undefined (use base guardrail)
     */
    liveMaxWorseningSellMicros: z.ZodOptional<z.ZodNumber>;
    /**
     * Override maxOverMidMicros for SELL orders in live mode.
     * Allows selling further below mid to ensure exits.
     * If not set, uses the base guardrail value.
     * Default: undefined (use base guardrail)
     */
    liveMaxUnderMidSellMicros: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    liveSlippageBpsBuy: number;
    liveSlippageBpsSell: number;
    liveBookFreshnessMs: number;
    liveBookWaitMs: number;
    liveOrderType: "FAK" | "FOK" | "GTC";
    useFokForCorrections: boolean;
    liveMaxWorseningSellMicros?: number | undefined;
    liveMaxUnderMidSellMicros?: number | undefined;
}, {
    liveSlippageBpsBuy?: number | undefined;
    liveSlippageBpsSell?: number | undefined;
    liveBookFreshnessMs?: number | undefined;
    liveBookWaitMs?: number | undefined;
    liveOrderType?: "FAK" | "FOK" | "GTC" | undefined;
    useFokForCorrections?: boolean | undefined;
    liveMaxWorseningSellMicros?: number | undefined;
    liveMaxUnderMidSellMicros?: number | undefined;
}>;
export type LiveGuardrails = z.infer<typeof LiveGuardrailsSchema>;
/**
 * Sizing mode for copy trading.
 * - fixedRate: Use a fixed copy percentage (current behavior)
 * - budgetedDynamic: Compute rate from budget / leader exposure
 */
export declare const SizingMode: {
    readonly FIXED_RATE: "fixedRate";
    readonly BUDGETED_DYNAMIC: "budgetedDynamic";
};
export type SizingModeType = (typeof SizingMode)[keyof typeof SizingMode];
/**
 * Budget enforcement mode for budgeted dynamic sizing.
 * - hard: Strictly cap exposure at budget; skip/reduce trades that exceed
 * - soft: Budget influences rate but doesn't hard-stop further exposure
 */
export declare const BudgetEnforcement: {
    readonly HARD: "hard";
    readonly SOFT: "soft";
};
export type BudgetEnforcementType = (typeof BudgetEnforcement)[keyof typeof BudgetEnforcement];
/**
 * Copy sizing configuration schema (base object).
 * Use SizingSchemaBase.partial() for parsing partial configs from DB.
 * Use SizingSchema for full validation with refinements.
 */
export declare const SizingSchemaBase: z.ZodObject<{
    /** Copy percentage of their notional in bps (default: 1 = 0.01%) */
    copyPctNotionalBps: z.ZodDefault<z.ZodNumber>;
    /** Minimum trade notional in micros (default: 10_000 = $0.01) */
    minTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /** Maximum trade notional in micros (default: 250_000_000 = $250) */
    maxTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /** Max trade as % of bankroll in bps (default: 75 = 0.75%) */
    maxTradeBankrollBps: z.ZodDefault<z.ZodNumber>;
    /**
     * Sizing mode: fixedRate (current behavior) or budgetedDynamic.
     * Default: fixedRate
     */
    sizingMode: z.ZodDefault<z.ZodEnum<["fixedRate", "budgetedDynamic"]>>;
    /**
     * Global kill switch for budgeted dynamic sizing.
     * When false, budgetedDynamic mode is disabled system-wide.
     * This field is only read from GLOBAL config; per-user overrides are ignored.
     * Default: false
     */
    budgetedDynamicEnabled: z.ZodDefault<z.ZodBoolean>;
    /**
     * Budget allocated to this leader in micros (e.g., 40_000_000 = $40).
     * Used to compute effective copy rate: r = budget / leaderExposure.
     * Default: 0 (must be set when using budgetedDynamic mode)
     */
    budgetUsdcMicros: z.ZodDefault<z.ZodNumber>;
    /**
     * Minimum effective copy rate in bps (floor for r_u).
     * Default: 0 (no floor)
     */
    budgetRMinBps: z.ZodDefault<z.ZodNumber>;
    /**
     * Maximum effective copy rate in bps (ceiling for r_u).
     * Default: 100 (1.00%) to match current default copy rate ceiling
     */
    budgetRMaxBps: z.ZodDefault<z.ZodNumber>;
    /**
     * Budget enforcement mode: hard or soft.
     * - hard: Strictly cap exposure at budget; skip/reduce trades that exceed
     * - soft: Budget influences rate but doesn't hard-stop further exposure
     * Default: hard
     */
    budgetEnforcement: z.ZodDefault<z.ZodEnum<["hard", "soft"]>>;
    /**
     * Minimum leader trade notional in micros to copy.
     * Leader trades below this size are skipped (useful for filtering whale spam).
     * Default: 0 (disabled)
     */
    minLeaderTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    copyPctNotionalBps: number;
    minTradeNotionalMicros: number;
    maxTradeNotionalMicros: number;
    maxTradeBankrollBps: number;
    sizingMode: "fixedRate" | "budgetedDynamic";
    budgetedDynamicEnabled: boolean;
    budgetUsdcMicros: number;
    budgetRMinBps: number;
    budgetRMaxBps: number;
    budgetEnforcement: "hard" | "soft";
    minLeaderTradeNotionalMicros: number;
}, {
    copyPctNotionalBps?: number | undefined;
    minTradeNotionalMicros?: number | undefined;
    maxTradeNotionalMicros?: number | undefined;
    maxTradeBankrollBps?: number | undefined;
    sizingMode?: "fixedRate" | "budgetedDynamic" | undefined;
    budgetedDynamicEnabled?: boolean | undefined;
    budgetUsdcMicros?: number | undefined;
    budgetRMinBps?: number | undefined;
    budgetRMaxBps?: number | undefined;
    budgetEnforcement?: "hard" | "soft" | undefined;
    minLeaderTradeNotionalMicros?: number | undefined;
}>;
/**
 * Copy sizing configuration schema with validation refinements.
 * Controls how much to copy from each trade.
 */
export declare const SizingSchema: z.ZodEffects<z.ZodObject<{
    /** Copy percentage of their notional in bps (default: 1 = 0.01%) */
    copyPctNotionalBps: z.ZodDefault<z.ZodNumber>;
    /** Minimum trade notional in micros (default: 10_000 = $0.01) */
    minTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /** Maximum trade notional in micros (default: 250_000_000 = $250) */
    maxTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
    /** Max trade as % of bankroll in bps (default: 75 = 0.75%) */
    maxTradeBankrollBps: z.ZodDefault<z.ZodNumber>;
    /**
     * Sizing mode: fixedRate (current behavior) or budgetedDynamic.
     * Default: fixedRate
     */
    sizingMode: z.ZodDefault<z.ZodEnum<["fixedRate", "budgetedDynamic"]>>;
    /**
     * Global kill switch for budgeted dynamic sizing.
     * When false, budgetedDynamic mode is disabled system-wide.
     * This field is only read from GLOBAL config; per-user overrides are ignored.
     * Default: false
     */
    budgetedDynamicEnabled: z.ZodDefault<z.ZodBoolean>;
    /**
     * Budget allocated to this leader in micros (e.g., 40_000_000 = $40).
     * Used to compute effective copy rate: r = budget / leaderExposure.
     * Default: 0 (must be set when using budgetedDynamic mode)
     */
    budgetUsdcMicros: z.ZodDefault<z.ZodNumber>;
    /**
     * Minimum effective copy rate in bps (floor for r_u).
     * Default: 0 (no floor)
     */
    budgetRMinBps: z.ZodDefault<z.ZodNumber>;
    /**
     * Maximum effective copy rate in bps (ceiling for r_u).
     * Default: 100 (1.00%) to match current default copy rate ceiling
     */
    budgetRMaxBps: z.ZodDefault<z.ZodNumber>;
    /**
     * Budget enforcement mode: hard or soft.
     * - hard: Strictly cap exposure at budget; skip/reduce trades that exceed
     * - soft: Budget influences rate but doesn't hard-stop further exposure
     * Default: hard
     */
    budgetEnforcement: z.ZodDefault<z.ZodEnum<["hard", "soft"]>>;
    /**
     * Minimum leader trade notional in micros to copy.
     * Leader trades below this size are skipped (useful for filtering whale spam).
     * Default: 0 (disabled)
     */
    minLeaderTradeNotionalMicros: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    copyPctNotionalBps: number;
    minTradeNotionalMicros: number;
    maxTradeNotionalMicros: number;
    maxTradeBankrollBps: number;
    sizingMode: "fixedRate" | "budgetedDynamic";
    budgetedDynamicEnabled: boolean;
    budgetUsdcMicros: number;
    budgetRMinBps: number;
    budgetRMaxBps: number;
    budgetEnforcement: "hard" | "soft";
    minLeaderTradeNotionalMicros: number;
}, {
    copyPctNotionalBps?: number | undefined;
    minTradeNotionalMicros?: number | undefined;
    maxTradeNotionalMicros?: number | undefined;
    maxTradeBankrollBps?: number | undefined;
    sizingMode?: "fixedRate" | "budgetedDynamic" | undefined;
    budgetedDynamicEnabled?: boolean | undefined;
    budgetUsdcMicros?: number | undefined;
    budgetRMinBps?: number | undefined;
    budgetRMaxBps?: number | undefined;
    budgetEnforcement?: "hard" | "soft" | undefined;
    minLeaderTradeNotionalMicros?: number | undefined;
}>, {
    copyPctNotionalBps: number;
    minTradeNotionalMicros: number;
    maxTradeNotionalMicros: number;
    maxTradeBankrollBps: number;
    sizingMode: "fixedRate" | "budgetedDynamic";
    budgetedDynamicEnabled: boolean;
    budgetUsdcMicros: number;
    budgetRMinBps: number;
    budgetRMaxBps: number;
    budgetEnforcement: "hard" | "soft";
    minLeaderTradeNotionalMicros: number;
}, {
    copyPctNotionalBps?: number | undefined;
    minTradeNotionalMicros?: number | undefined;
    maxTradeNotionalMicros?: number | undefined;
    maxTradeBankrollBps?: number | undefined;
    sizingMode?: "fixedRate" | "budgetedDynamic" | undefined;
    budgetedDynamicEnabled?: boolean | undefined;
    budgetUsdcMicros?: number | undefined;
    budgetRMinBps?: number | undefined;
    budgetRMaxBps?: number | undefined;
    budgetEnforcement?: "hard" | "soft" | undefined;
    minLeaderTradeNotionalMicros?: number | undefined;
}>;
export type Sizing = z.infer<typeof SizingSchemaBase>;
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
    /**
     * Whether paper trading (simulation) is enabled.
     * When true, paper copy attempts are generated and simulated fills recorded.
     * Default: true
     */
    paperTradingEnabled: z.ZodDefault<z.ZodBoolean>;
    /**
     * Whether live trading (real orders) is enabled.
     * When true, live copy attempts place real CLOB orders.
     * Default: false (must be explicitly enabled)
     */
    liveTradingEnabled: z.ZodDefault<z.ZodBoolean>;
    /**
     * Whether live trading read-only mode is enabled.
     * When true, live portfolio monitoring (positions/cash reconciliation)
     * runs even if liveTradingEnabled=false.
     * Useful for monitoring wallet state without placing orders.
     * Default: false
     */
    liveTradingReadOnlyEnabled: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    copyEngineEnabled: boolean;
    aggregationWindowMs: number;
    pollingIntervalMs: number;
    backfillMinutes: number;
    initialBankrollMicros: number;
    paperTradingEnabled: boolean;
    liveTradingEnabled: boolean;
    liveTradingReadOnlyEnabled: boolean;
}, {
    copyEngineEnabled?: boolean | undefined;
    aggregationWindowMs?: number | undefined;
    pollingIntervalMs?: number | undefined;
    backfillMinutes?: number | undefined;
    initialBankrollMicros?: number | undefined;
    paperTradingEnabled?: boolean | undefined;
    liveTradingEnabled?: boolean | undefined;
    liveTradingReadOnlyEnabled?: boolean | undefined;
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
