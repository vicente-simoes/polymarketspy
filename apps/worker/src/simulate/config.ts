/**
 * Simulation configuration with locked defaults from planning.md.
 *
 * These values can be overridden via GuardrailConfig and CopySizingConfig
 * in the database, but these are the defaults.
 */

import { ConfigScope } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { GuardrailsSchema, SizingSchema, type Guardrails, type Sizing } from "@copybot/shared";

const logger = createChildLogger({ module: "simulation-config" });

/**
 * Default guardrails (locked in planning.md).
 */
export const DEFAULT_GUARDRAILS: Guardrails = {
    // Price protection
    maxWorseningVsTheirFillMicros: 10_000, // $0.01
    maxOverMidMicros: 15_000, // $0.015
    maxSpreadMicros: 20_000, // $0.02
    minDepthMultiplierBps: 12_500, // 1.25x = 12500 bps

    // Timing
    decisionLatencyMs: 750,
    jitterMsMax: 250,

    // Market lifecycle
    noNewOpensWithinMinutesToClose: 30,

    // Risk limits (in basis points of equity)
    maxTotalExposureBps: 7000, // 70%
    maxExposurePerMarketBps: 500, // 5%
    maxExposurePerUserBps: 2000, // 20%

    // Circuit breakers (in basis points)
    dailyLossLimitBps: 300, // 3%
    weeklyLossLimitBps: 800, // 8%
    maxDrawdownLimitBps: 1200, // 12%
};

/**
 * Default sizing (locked in planning.md).
 */
export const DEFAULT_SIZING: Sizing = {
    copyPctNotionalBps: 100, // 1% = 100 bps
    minTradeNotionalMicros: 5_000_000, // 5 USDC
    maxTradeNotionalMicros: 250_000_000, // 250 USDC
    maxTradeBankrollBps: 75, // 0.75% = 75 bps
};

/**
 * Cache for effective configs (refreshed on demand).
 */
interface ConfigCache {
    global: {
        guardrails: Guardrails;
        sizing: Sizing;
        loadedAt: Date;
    } | null;
    perUser: Map<string, {
        guardrails: Guardrails;
        sizing: Sizing;
        loadedAt: Date;
    }>;
}

const cache: ConfigCache = {
    global: null,
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
async function loadGlobalConfig(): Promise<{ guardrails: Guardrails; sizing: Sizing }> {
    // Load guardrails
    const guardrailRow = await prisma.guardrailConfig.findFirst({
        where: { scope: ConfigScope.GLOBAL },
    });

    let guardrails = DEFAULT_GUARDRAILS;
    if (guardrailRow) {
        try {
            const parsed = GuardrailsSchema.parse(guardrailRow.configJson);
            guardrails = { ...DEFAULT_GUARDRAILS, ...parsed };
        } catch (err) {
            logger.warn({ err }, "Failed to parse global guardrails, using defaults");
        }
    }

    // Load sizing
    const sizingRow = await prisma.copySizingConfig.findFirst({
        where: { scope: ConfigScope.GLOBAL },
    });

    let sizing = DEFAULT_SIZING;
    if (sizingRow) {
        try {
            const parsed = SizingSchema.parse(sizingRow.configJson);
            sizing = { ...DEFAULT_SIZING, ...parsed };
        } catch (err) {
            logger.warn({ err }, "Failed to parse global sizing, using defaults");
        }
    }

    return { guardrails, sizing };
}

/**
 * Load per-user config overrides from database.
 */
async function loadUserConfig(
    followedUserId: string,
    globalGuardrails: Guardrails,
    globalSizing: Sizing
): Promise<{ guardrails: Guardrails; sizing: Sizing }> {
    // Load user-specific guardrails
    const guardrailRow = await prisma.guardrailConfig.findFirst({
        where: {
            scope: ConfigScope.USER,
            followedUserId,
        },
    });

    let guardrails = globalGuardrails;
    if (guardrailRow) {
        try {
            const parsed = GuardrailsSchema.partial().parse(guardrailRow.configJson);
            guardrails = { ...globalGuardrails, ...parsed };
        } catch (err) {
            logger.warn({ err, followedUserId }, "Failed to parse user guardrails, using global");
        }
    }

    // Load user-specific sizing
    const sizingRow = await prisma.copySizingConfig.findFirst({
        where: {
            scope: ConfigScope.USER,
            followedUserId,
        },
    });

    let sizing = globalSizing;
    if (sizingRow) {
        try {
            const parsed = SizingSchema.partial().parse(sizingRow.configJson);
            sizing = { ...globalSizing, ...parsed };
        } catch (err) {
            logger.warn({ err, followedUserId }, "Failed to parse user sizing, using global");
        }
    }

    return { guardrails, sizing };
}

/**
 * Get effective guardrails and sizing for global portfolio.
 */
export async function getGlobalConfig(): Promise<{ guardrails: Guardrails; sizing: Sizing }> {
    // Check cache
    if (cache.global && isCacheValid(cache.global.loadedAt)) {
        return { guardrails: cache.global.guardrails, sizing: cache.global.sizing };
    }

    // Load from DB
    const config = await loadGlobalConfig();

    // Update cache
    cache.global = {
        guardrails: config.guardrails,
        sizing: config.sizing,
        loadedAt: new Date(),
    };

    return config;
}

/**
 * Get effective guardrails and sizing for a specific user.
 * Merges global config with user-specific overrides.
 */
export async function getUserConfig(
    followedUserId: string
): Promise<{ guardrails: Guardrails; sizing: Sizing }> {
    // Check cache
    const cached = cache.perUser.get(followedUserId);
    if (cached && isCacheValid(cached.loadedAt)) {
        return { guardrails: cached.guardrails, sizing: cached.sizing };
    }

    // Load global config first
    const global = await getGlobalConfig();

    // Load user overrides
    const config = await loadUserConfig(followedUserId, global.guardrails, global.sizing);

    // Update cache
    cache.perUser.set(followedUserId, {
        guardrails: config.guardrails,
        sizing: config.sizing,
        loadedAt: new Date(),
    });

    return config;
}

/**
 * Clear config cache (call after config updates).
 */
export function clearConfigCache(): void {
    cache.global = null;
    cache.perUser.clear();
    logger.debug("Config cache cleared");
}
