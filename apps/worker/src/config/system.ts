import { SystemConfigSchema, type SystemConfig } from "@copybot/shared";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { AGGREGATION_WINDOW_MS } from "../simulate/types.js";

const logger = createChildLogger({ module: "system-config" });

const SYSTEM_CONFIG_KEY = "system:config";

const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
    copyEngineEnabled: true,
    aggregationWindowMs: AGGREGATION_WINDOW_MS,
    pollingIntervalMs: 30_000,
    backfillMinutes: 15,
    // Default bankroll: 0 (starts at 0 equity, positions add value, cash subtracts)
    initialBankrollMicros: 0,
};

const CACHE_TTL_MS = 30_000;

let cache: { config: SystemConfig; loadedAt: number } | null = null;

export async function getSystemConfig(): Promise<SystemConfig> {
    if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
        return cache.config;
    }

    const row = await prisma.systemCheckpoint.findUnique({
        where: { key: SYSTEM_CONFIG_KEY },
    });

    let overrides: Partial<SystemConfig> = {};
    if (row?.valueJson) {
        try {
            overrides = SystemConfigSchema.partial().parse(row.valueJson);
        } catch (err) {
            logger.warn({ err }, "Failed to parse system config, using defaults");
        }
    }

    const config: SystemConfig = { ...DEFAULT_SYSTEM_CONFIG, ...overrides };
    cache = { config, loadedAt: Date.now() };
    return config;
}

export function clearSystemConfigCache(): void {
    cache = null;
}

