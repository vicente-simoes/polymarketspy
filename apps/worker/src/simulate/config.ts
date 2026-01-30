/**
 * Simulation configuration with locked defaults from planning.md.
 *
 * These values can be overridden via GuardrailConfig and CopySizingConfig
 * in the database, but these are the defaults.
 */

import { ConfigScope, TradingMode } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    GuardrailsSchema,
    SizingSchemaBase,
    SmallTradeBufferingSchema,
    LiveGuardrailsSchema,
    SmallTradeNettingMode,
    SizingMode,
    BudgetEnforcement,
    type Guardrails,
    type Sizing,
    type SmallTradeBuffering,
    type LiveGuardrails,
} from "@copybot/shared";

const logger = createChildLogger({ module: "simulation-config" });

/**
 * Default guardrails (locked in planning.md).
 */
export const DEFAULT_GUARDRAILS: Guardrails = {
    // Price protection
    maxWorseningVsTheirFillMicros: 20_000, // $0.02
    maxOverMidMicros: 15_000, // $0.015
    maxSpreadMicros: 20_000, // $0.02
    minDepthMultiplierBps: 12_500, // 1.25x = 12500 bps

    // Timing
    decisionLatencyMs: 0,
    jitterMsMax: 0,

    // Market lifecycle
    noNewOpensWithinMinutesToClose: 1,

    // Risk limits (in basis points of equity)
    maxTotalExposureBps: 10_000, // 100%
    maxExposurePerMarketBps: 10_000, // 100%
    maxExposurePerUserBps: 10_000, // 100%

    // Circuit breakers (in basis points)
    dailyLossLimitBps: 10_000, // 100%
    weeklyLossLimitBps: 10_000, // 100%
    maxDrawdownLimitBps: 10_000, // 100%
};

/**
 * Default sizing (locked in planning.md).
 */
export const DEFAULT_SIZING: Sizing = {
    copyPctNotionalBps: 1, // 0.01% = 1 bps
    minTradeNotionalMicros: 10_000, // $0.01 USDC
    maxTradeNotionalMicros: 250_000_000, // 250 USDC
    maxTradeBankrollBps: 75, // 0.75% = 75 bps

    // Budgeted Dynamic (disabled by default - no behavior change)
    sizingMode: SizingMode.FIXED_RATE,
    budgetedDynamicEnabled: false,
    budgetUsdcMicros: 0,
    budgetRMinBps: 0,
    budgetRMaxBps: 100, // 1.00% ceiling
    budgetEnforcement: BudgetEnforcement.HARD,
    minLeaderTradeNotionalMicros: 0, // disabled
};

/**
 * Default small trade buffering config.
 * Disabled by default - no behavior change unless enabled.
 */
export const DEFAULT_SMALL_TRADE_BUFFERING: SmallTradeBuffering = {
    enabled: false,
    notionalThresholdMicros: 250_000, // $0.25
    flushMinNotionalMicros: 500_000, // $0.50
    minExecNotionalMicros: 100_000, // $0.10
    maxBufferMs: 2500,
    quietFlushMs: 600,
    nettingMode: SmallTradeNettingMode.SAME_SIDE_ONLY,
};

/**
 * Default live guardrails config.
 */
export const DEFAULT_LIVE_GUARDRAILS: LiveGuardrails = {
    liveSlippageBpsBuy: 50, // 0.5%
    liveSlippageBpsSell: 100, // 1.0% - more tolerant to not miss exits
    liveBookFreshnessMs: 2000,
    liveBookWaitMs: 500,
    liveOrderType: "FAK",
};

/**
 * Config result type.
 */
interface ConfigResult {
    guardrails: Guardrails;
    sizing: Sizing;
    smallTradeBuffering: SmallTradeBuffering;
    liveGuardrails?: LiveGuardrails;
    loadedAt: Date;
}

/**
 * Cache for effective configs (refreshed on demand).
 * Keys include tradingMode for mode-aware caching.
 */
interface ConfigCache {
    global: Map<TradingMode, ConfigResult>;
    perUser: Map<string, ConfigResult>; // Key format: `${followedUserId}:${tradingMode}`
}

const cache: ConfigCache = {
    global: new Map(),
    perUser: new Map(),
};

// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Check if cache entry is still valid.
 */
function isCacheValid(loadedAt: Date): boolean {
    return Date.now() - loadedAt.getTime() < CACHE_TTL_MS;
}

/**
 * Load global config from database.
 */
async function loadGlobalConfig(
    tradingMode: TradingMode = TradingMode.PAPER
): Promise<{
    guardrails: Guardrails;
    sizing: Sizing;
    smallTradeBuffering: SmallTradeBuffering;
    liveGuardrails?: LiveGuardrails;
}> {
    // Load guardrails - filter by tradingMode
    const guardrailRow = await prisma.guardrailConfig.findFirst({
        where: {
            scope: ConfigScope.GLOBAL,
            followedUserId: null,
            tradingMode,
        },
        orderBy: { updatedAt: "desc" },
    });

    let guardrails = DEFAULT_GUARDRAILS;
    if (guardrailRow) {
        try {
            const parsed = GuardrailsSchema.partial().parse(guardrailRow.configJson);
            guardrails = { ...DEFAULT_GUARDRAILS, ...parsed };
        } catch (err) {
            logger.warn({ err, tradingMode }, "Failed to parse global guardrails, using defaults");
        }
    }

    // Load sizing - filter by tradingMode
    const sizingRow = await prisma.copySizingConfig.findFirst({
        where: {
            scope: ConfigScope.GLOBAL,
            followedUserId: null,
            tradingMode,
        },
        orderBy: { updatedAt: "desc" },
    });

    let sizing = DEFAULT_SIZING;
    if (sizingRow) {
        try {
            const parsed = SizingSchemaBase.partial().parse(sizingRow.configJson);
            sizing = { ...DEFAULT_SIZING, ...parsed };
        } catch (err) {
            logger.warn({ err, tradingMode }, "Failed to parse global sizing, using defaults");
        }
    }

    // Load small trade buffering config from SystemCheckpoint (mode-aware key)
    const bufferingKey = tradingMode === TradingMode.LIVE
        ? "config:smallTradeBuffering:LIVE"
        : "config:smallTradeBuffering:PAPER";
    const bufferingRow = await prisma.systemCheckpoint.findUnique({
        where: { key: bufferingKey },
    });

    // Fall back to legacy key for PAPER mode
    let smallTradeBuffering = DEFAULT_SMALL_TRADE_BUFFERING;
    if (bufferingRow) {
        try {
            const parsed = SmallTradeBufferingSchema.partial().parse(bufferingRow.valueJson);
            smallTradeBuffering = { ...DEFAULT_SMALL_TRADE_BUFFERING, ...parsed };
        } catch (err) {
            logger.warn({ err, tradingMode }, "Failed to parse small trade buffering config, using defaults");
        }
    } else if (tradingMode === TradingMode.PAPER) {
        // Fall back to legacy key for backward compatibility
        const legacyRow = await prisma.systemCheckpoint.findUnique({
            where: { key: "config:smallTradeBuffering" },
        });
        if (legacyRow) {
            try {
                const parsed = SmallTradeBufferingSchema.partial().parse(legacyRow.valueJson);
                smallTradeBuffering = { ...DEFAULT_SMALL_TRADE_BUFFERING, ...parsed };
            } catch (err) {
                logger.warn({ err }, "Failed to parse legacy small trade buffering config");
            }
        }
    }

    // Load live guardrails (only for LIVE mode)
    let liveGuardrails: LiveGuardrails | undefined;
    if (tradingMode === TradingMode.LIVE) {
        const liveGuardrailsRow = await prisma.systemCheckpoint.findUnique({
            where: { key: "config:liveGuardrails" },
        });

        liveGuardrails = DEFAULT_LIVE_GUARDRAILS;
        if (liveGuardrailsRow) {
            try {
                const parsed = LiveGuardrailsSchema.partial().parse(liveGuardrailsRow.valueJson);
                liveGuardrails = { ...DEFAULT_LIVE_GUARDRAILS, ...parsed };
            } catch (err) {
                logger.warn({ err }, "Failed to parse live guardrails config, using defaults");
            }
        }
    }

    return { guardrails, sizing, smallTradeBuffering, liveGuardrails };
}

/**
 * Load per-user config overrides from database.
 * Note: smallTradeBuffering and liveGuardrails are global-only for now.
 */
async function loadUserConfig(
    followedUserId: string,
    globalGuardrails: Guardrails,
    globalSizing: Sizing,
    globalSmallTradeBuffering: SmallTradeBuffering,
    globalLiveGuardrails: LiveGuardrails | undefined,
    tradingMode: TradingMode = TradingMode.PAPER
): Promise<{
    guardrails: Guardrails;
    sizing: Sizing;
    smallTradeBuffering: SmallTradeBuffering;
    liveGuardrails?: LiveGuardrails;
}> {
    // Load user-specific guardrails - filter by tradingMode
    const guardrailRow = await prisma.guardrailConfig.findFirst({
        where: {
            scope: ConfigScope.USER,
            followedUserId,
            tradingMode,
        },
        orderBy: { updatedAt: "desc" },
    });

    let guardrails = globalGuardrails;
    if (guardrailRow) {
        try {
            const parsed = GuardrailsSchema.partial().parse(guardrailRow.configJson);
            guardrails = { ...globalGuardrails, ...parsed };
        } catch (err) {
            logger.warn({ err, followedUserId, tradingMode }, "Failed to parse user guardrails, using global");
        }
    }

    // Load user-specific sizing - filter by tradingMode
    const sizingRow = await prisma.copySizingConfig.findFirst({
        where: {
            scope: ConfigScope.USER,
            followedUserId,
            tradingMode,
        },
        orderBy: { updatedAt: "desc" },
    });

    let sizing = globalSizing;
    if (sizingRow) {
        try {
            const parsed = SizingSchemaBase.partial().parse(sizingRow.configJson);
            // Drop budgetedDynamicEnabled from per-user config - it's a GLOBAL-only kill switch
            const { budgetedDynamicEnabled: _ignored, ...userSizingOverrides } = parsed;
            sizing = { ...globalSizing, ...userSizingOverrides };
        } catch (err) {
            logger.warn({ err, followedUserId, tradingMode }, "Failed to parse user sizing, using global");
        }
    }

    // smallTradeBuffering and liveGuardrails are global-only (no per-user overrides)
    const smallTradeBuffering = globalSmallTradeBuffering;
    const liveGuardrails = globalLiveGuardrails;

    return { guardrails, sizing, smallTradeBuffering, liveGuardrails };
}

/**
 * Get effective guardrails, sizing, and small trade buffering for global portfolio.
 * @param tradingMode - Trading mode (PAPER or LIVE), defaults to PAPER
 */
export async function getGlobalConfig(
    tradingMode: TradingMode = TradingMode.PAPER
): Promise<{
    guardrails: Guardrails;
    sizing: Sizing;
    smallTradeBuffering: SmallTradeBuffering;
    liveGuardrails?: LiveGuardrails;
}> {
    // Check cache
    const cached = cache.global.get(tradingMode);
    if (cached && isCacheValid(cached.loadedAt)) {
        return {
            guardrails: cached.guardrails,
            sizing: cached.sizing,
            smallTradeBuffering: cached.smallTradeBuffering,
            liveGuardrails: cached.liveGuardrails,
        };
    }

    // Load from DB
    const config = await loadGlobalConfig(tradingMode);

    // Update cache
    cache.global.set(tradingMode, {
        guardrails: config.guardrails,
        sizing: config.sizing,
        smallTradeBuffering: config.smallTradeBuffering,
        liveGuardrails: config.liveGuardrails,
        loadedAt: new Date(),
    });

    return config;
}

/**
 * Get effective guardrails, sizing, and small trade buffering for a specific user.
 * Merges global config with user-specific overrides.
 * @param followedUserId - The user to get config for
 * @param tradingMode - Trading mode (PAPER or LIVE), defaults to PAPER
 */
export async function getUserConfig(
    followedUserId: string,
    tradingMode: TradingMode = TradingMode.PAPER
): Promise<{
    guardrails: Guardrails;
    sizing: Sizing;
    smallTradeBuffering: SmallTradeBuffering;
    liveGuardrails?: LiveGuardrails;
}> {
    // Build cache key
    const cacheKey = `${followedUserId}:${tradingMode}`;

    // Check cache
    const cached = cache.perUser.get(cacheKey);
    if (cached && isCacheValid(cached.loadedAt)) {
        return {
            guardrails: cached.guardrails,
            sizing: cached.sizing,
            smallTradeBuffering: cached.smallTradeBuffering,
            liveGuardrails: cached.liveGuardrails,
        };
    }

    // Load global config first
    const global = await getGlobalConfig(tradingMode);

    // Load user overrides
    const config = await loadUserConfig(
        followedUserId,
        global.guardrails,
        global.sizing,
        global.smallTradeBuffering,
        global.liveGuardrails,
        tradingMode
    );

    // Update cache
    cache.perUser.set(cacheKey, {
        guardrails: config.guardrails,
        sizing: config.sizing,
        smallTradeBuffering: config.smallTradeBuffering,
        liveGuardrails: config.liveGuardrails,
        loadedAt: new Date(),
    });

    return config;
}

/**
 * Clear config cache (call after config updates).
 */
export function clearConfigCache(): void {
    cache.global.clear();
    cache.perUser.clear();
    logger.debug("Config cache cleared");
}
