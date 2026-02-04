/**
 * Simulation configuration with locked defaults from planning.md.
 *
 * These values can be overridden via GuardrailConfig and CopySizingConfig
 * in the database, but these are the defaults.
 *
 * Config loading is mode-aware: PAPER and LIVE configs are stored and
 * loaded independently.
 */

import { ConfigScope, TradingMode } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    GuardrailsSchema,
    LiveGuardrailsSchema,
    LiveOrderType,
    SizingSchemaBase,
    SmallTradeBufferingSchema,
    SmallTradeNettingMode,
    SizingMode,
    BudgetEnforcement,
    type Guardrails,
    type LiveGuardrails,
    type Sizing,
    type SmallTradeBuffering,
} from "@copybot/shared";

const logger = createChildLogger({ module: "simulation-config" });

const BUDGETED_DYNAMIC_DISABLED = true;

function enforceFixedRateSizing(sizing: Sizing): Sizing {
    if (!BUDGETED_DYNAMIC_DISABLED) return sizing;

    if (sizing.budgetedDynamicEnabled || sizing.sizingMode === SizingMode.BUDGETED_DYNAMIC) {
        logger.warn(
            {
                sizingMode: sizing.sizingMode,
                budgetedDynamicEnabled: sizing.budgetedDynamicEnabled,
            },
            "Budgeted dynamic sizing is disabled; forcing fixed-rate"
        );
    }

    return {
        ...sizing,
        sizingMode: SizingMode.FIXED_RATE,
        budgetedDynamicEnabled: false,
    };
}

/**
 * Default guardrails (locked in planning.md).
 * Used for both PAPER and LIVE base guardrails.
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
 * Default live-specific guardrails.
 * These are additional guardrails specific to live trading execution.
 */
export const DEFAULT_LIVE_GUARDRAILS: LiveGuardrails = {
    // Slippage tolerance (in basis points)
    liveSlippageBpsBuy: 50, // 0.50% for BUY
    liveSlippageBpsSell: 100, // 1.00% for SELL (more tolerant to avoid missing exits)

    // Book freshness requirements
    liveBookFreshnessMs: 2000, // 2 seconds max book age
    liveBookWaitMs: 500, // Wait 500ms for fresh book before SKIP

    // Order type configuration
    liveOrderType: LiveOrderType.FAK, // Fill-And-Kill by default
    useFokForCorrections: false, // Don't use FOK for corrections by default

    // Optional SELL-side tolerance overrides (undefined = use base guardrail)
    liveMaxWorseningSellMicros: undefined,
    liveMaxUnderMidSellMicros: undefined,
};

/**
 * Default sizing (locked in planning.md).
 * Used for both PAPER and LIVE sizing.
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
 * Config is mode-aware (separate for PAPER and LIVE).
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
 * Get the SystemCheckpoint key for small trade buffering config.
 * Mode-aware: uses different keys for PAPER and LIVE.
 */
function getSmallTradeBufferingKey(mode: TradingMode): string {
    return `config:smallTradeBuffering:${mode}`;
}

/**
 * Full config including base guardrails + live-specific guardrails.
 */
export interface FullConfig {
    guardrails: Guardrails;
    liveGuardrails: LiveGuardrails;
    sizing: Sizing;
    smallTradeBuffering: SmallTradeBuffering;
}

/**
 * Cache for effective configs (refreshed on demand).
 * Keyed by trading mode.
 */
interface ConfigCache {
    global: Map<TradingMode, {
        config: FullConfig;
        loadedAt: Date;
    }>;
    perUser: Map<string, {
        config: FullConfig;
        loadedAt: Date;
    }>;
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
 * Get cache key for per-user config (mode + userId).
 */
function getUserCacheKey(mode: TradingMode, followedUserId: string): string {
    return `${mode}:${followedUserId}`;
}

/**
 * Load global config from database for a specific trading mode.
 */
async function loadGlobalConfigForMode(mode: TradingMode): Promise<FullConfig> {
    // Load base guardrails
    const guardrailRow = await prisma.guardrailConfig.findFirst({
        where: { scope: ConfigScope.GLOBAL, tradingMode: mode, followedUserId: null },
        orderBy: { updatedAt: "desc" },
    });

    let guardrails = DEFAULT_GUARDRAILS;
    let liveGuardrails = DEFAULT_LIVE_GUARDRAILS;

    if (guardrailRow) {
        try {
            // Parse base guardrails
            const parsed = GuardrailsSchema.partial().parse(guardrailRow.configJson);
            guardrails = { ...DEFAULT_GUARDRAILS, ...parsed };

            // Parse live-specific guardrails from the same configJson
            // (they're stored together but have distinct field names)
            if (mode === TradingMode.LIVE) {
                const liveParsed = LiveGuardrailsSchema.partial().parse(guardrailRow.configJson);
                liveGuardrails = { ...DEFAULT_LIVE_GUARDRAILS, ...liveParsed };
            }
        } catch (err) {
            logger.warn({ err, mode }, "Failed to parse global guardrails, using defaults");
        }
    }

    // Load sizing
    const sizingRow = await prisma.copySizingConfig.findFirst({
        where: { scope: ConfigScope.GLOBAL, tradingMode: mode, followedUserId: null },
        orderBy: { updatedAt: "desc" },
    });

    let sizing = DEFAULT_SIZING;
    if (sizingRow) {
        try {
            const parsed = SizingSchemaBase.partial().parse(sizingRow.configJson);
            sizing = { ...DEFAULT_SIZING, ...parsed };
        } catch (err) {
            logger.warn({ err, mode }, "Failed to parse global sizing, using defaults");
        }
    }
    sizing = enforceFixedRateSizing(sizing);

    // Load small trade buffering config from SystemCheckpoint
    // Mode-aware: uses different keys for PAPER and LIVE
    const bufferingKey = getSmallTradeBufferingKey(mode);
    const bufferingRow = await prisma.systemCheckpoint.findUnique({
        where: { key: bufferingKey },
    });

    let smallTradeBuffering = DEFAULT_SMALL_TRADE_BUFFERING;
    if (bufferingRow) {
        try {
            const parsed = SmallTradeBufferingSchema.partial().parse(bufferingRow.valueJson);
            smallTradeBuffering = { ...DEFAULT_SMALL_TRADE_BUFFERING, ...parsed };
        } catch (err) {
            logger.warn({ err, mode }, "Failed to parse small trade buffering config, using defaults");
        }
    } else if (mode === TradingMode.PAPER) {
        // Fallback: try reading the legacy non-mode-aware key for backward compatibility
        const legacyRow = await prisma.systemCheckpoint.findUnique({
            where: { key: "config:smallTradeBuffering" },
        });
        if (legacyRow) {
            try {
                const parsed = SmallTradeBufferingSchema.partial().parse(legacyRow.valueJson);
                smallTradeBuffering = { ...DEFAULT_SMALL_TRADE_BUFFERING, ...parsed };
                logger.debug({ mode }, "Using legacy smallTradeBuffering config (not mode-specific)");
            } catch (err) {
                logger.warn({ err, mode }, "Failed to parse legacy small trade buffering config");
            }
        }
    }

    return { guardrails, liveGuardrails, sizing, smallTradeBuffering };
}

/**
 * Load per-user config overrides from database for a specific trading mode.
 * Note: smallTradeBuffering is global-only for now, but structure supports per-user in future.
 */
async function loadUserConfigForMode(
    mode: TradingMode,
    followedUserId: string,
    globalConfig: FullConfig
): Promise<FullConfig> {
    // Load user-specific guardrails
    const guardrailRow = await prisma.guardrailConfig.findFirst({
        where: {
            scope: ConfigScope.USER,
            tradingMode: mode,
            followedUserId,
        },
        orderBy: { updatedAt: "desc" },
    });

    let guardrails = globalConfig.guardrails;
    let liveGuardrails = globalConfig.liveGuardrails;

    if (guardrailRow) {
        try {
            const parsed = GuardrailsSchema.partial().parse(guardrailRow.configJson);
            guardrails = { ...globalConfig.guardrails, ...parsed };

            // Parse live-specific guardrails from the same configJson
            if (mode === TradingMode.LIVE) {
                const liveParsed = LiveGuardrailsSchema.partial().parse(guardrailRow.configJson);
                liveGuardrails = { ...globalConfig.liveGuardrails, ...liveParsed };
            }
        } catch (err) {
            logger.warn({ err, followedUserId, mode }, "Failed to parse user guardrails, using global");
        }
    }

    // Load user-specific sizing
    const sizingRow = await prisma.copySizingConfig.findFirst({
        where: {
            scope: ConfigScope.USER,
            tradingMode: mode,
            followedUserId,
        },
        orderBy: { updatedAt: "desc" },
    });

    let sizing = globalConfig.sizing;
    if (sizingRow) {
        try {
            const parsed = SizingSchemaBase.partial().parse(sizingRow.configJson);
            // Drop budgetedDynamicEnabled from per-user config - it's a GLOBAL-only kill switch
            const { budgetedDynamicEnabled: _ignored, ...userSizingOverrides } = parsed;
            sizing = { ...globalConfig.sizing, ...userSizingOverrides };
        } catch (err) {
            logger.warn({ err, followedUserId, mode }, "Failed to parse user sizing, using global");
        }
    }
    sizing = enforceFixedRateSizing(sizing);

    // For now, small trade buffering is global-only (no per-user overrides)
    // Future: could load from a per-user SystemCheckpoint or new table
    const smallTradeBuffering = globalConfig.smallTradeBuffering;

    return { guardrails, liveGuardrails, sizing, smallTradeBuffering };
}

/**
 * Get effective config for global portfolio (mode-aware).
 * Returns base guardrails, live-specific guardrails, sizing, and small trade buffering.
 */
export async function getGlobalConfig(mode: TradingMode = TradingMode.PAPER): Promise<FullConfig> {
    // Check cache
    const cached = cache.global.get(mode);
    if (cached && isCacheValid(cached.loadedAt)) {
        return cached.config;
    }

    // Load from DB
    const config = await loadGlobalConfigForMode(mode);

    // Update cache
    cache.global.set(mode, {
        config,
        loadedAt: new Date(),
    });

    return config;
}

/**
 * Get effective config for a specific user (mode-aware).
 * Merges global config with user-specific overrides.
 */
export async function getUserConfig(
    mode: TradingMode = TradingMode.PAPER,
    followedUserId: string
): Promise<FullConfig> {
    // Check cache
    const cacheKey = getUserCacheKey(mode, followedUserId);
    const cached = cache.perUser.get(cacheKey);
    if (cached && isCacheValid(cached.loadedAt)) {
        return cached.config;
    }

    // Load global config first
    const globalConfig = await getGlobalConfig(mode);

    // Load user overrides
    const config = await loadUserConfigForMode(mode, followedUserId, globalConfig);

    // Update cache
    cache.perUser.set(cacheKey, {
        config,
        loadedAt: new Date(),
    });

    return config;
}

/**
 * Clear config cache (call after config updates).
 * Can optionally clear only for a specific mode.
 */
export function clearConfigCache(mode?: TradingMode): void {
    if (mode) {
        cache.global.delete(mode);
        // Clear per-user cache entries for this mode
        for (const key of cache.perUser.keys()) {
            if (key.startsWith(`${mode}:`)) {
                cache.perUser.delete(key);
            }
        }
        logger.debug({ mode }, "Config cache cleared for mode");
    } else {
        cache.global.clear();
        cache.perUser.clear();
        logger.debug("Config cache cleared (all modes)");
    }
}

// ─── Legacy exports for backward compatibility ────────────────────────────────
// These maintain the old API signature for existing code that doesn't pass mode.
// They default to PAPER mode.

/**
 * @deprecated Use getGlobalConfig(TradingMode.PAPER) instead
 */
export async function getGlobalPaperConfig(): Promise<{
    guardrails: Guardrails;
    sizing: Sizing;
    smallTradeBuffering: SmallTradeBuffering;
}> {
    const config = await getGlobalConfig(TradingMode.PAPER);
    return {
        guardrails: config.guardrails,
        sizing: config.sizing,
        smallTradeBuffering: config.smallTradeBuffering,
    };
}

/**
 * @deprecated Use getUserConfig(TradingMode.PAPER, followedUserId) instead
 */
export async function getUserPaperConfig(
    followedUserId: string
): Promise<{ guardrails: Guardrails; sizing: Sizing; smallTradeBuffering: SmallTradeBuffering }> {
    const config = await getUserConfig(TradingMode.PAPER, followedUserId);
    return {
        guardrails: config.guardrails,
        sizing: config.sizing,
        smallTradeBuffering: config.smallTradeBuffering,
    };
}
