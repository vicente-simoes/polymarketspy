import { EquityPointGranularity, TradingMode, PortfolioScope } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { getSystemConfig } from "../config/system.js";
import { getBucketMs, isWithinBoundaryWindow } from "./equityMath.js";
import { EQUITY_BOUNDARY_WINDOW_MS, EQUITY_GRANULARITIES, EQUITY_TICK_INTERVAL_MS } from "./equityPolicy.js";

const logger = createChildLogger({ module: "equity-points" });

const DEFAULT_MARK_PRICE_MICROS = 500_000; // $0.50
const LIVE_BASELINE_EQUITY_KEY = "live:baselineEquityMicros";

const GRANULARITIES = EQUITY_GRANULARITIES;

let equityTickTimeout: ReturnType<typeof setTimeout> | null = null;
let equityTickInterval: ReturnType<typeof setInterval> | null = null;
let retentionTimeout: ReturnType<typeof setTimeout> | null = null;
let retentionInterval: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;
const lastBucketMsByModeGranularity = new Map<string, number>();

function getBucketTime(timestampMs: number, intervalMs: number): Date {
    return new Date(getBucketMs(timestampMs, intervalMs));
}

function parseBaselineEquityMicros(valueJson: unknown): bigint | null {
    const raw = (valueJson as any)?.equityMicros;
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return BigInt(Math.trunc(raw));
    }
    if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
        try {
            return BigInt(raw);
        } catch {
            return null;
        }
    }
    return null;
}

async function getLiveBaselineEquityMicros(): Promise<bigint | null> {
    const row = await prisma.systemCheckpoint.findUnique({
        where: { key: LIVE_BASELINE_EQUITY_KEY },
        select: { valueJson: true },
    });
    if (!row) return null;
    return parseBaselineEquityMicros(row.valueJson);
}

async function computeEquitySnapshot(tradingMode: TradingMode): Promise<{
    equityMicros: bigint;
    contributedCapitalMicros: bigint;
    pnlMicros: bigint;
    positionCount: number;
}> {
    const initialBankrollMicros =
        tradingMode === TradingMode.PAPER
            ? BigInt((await getSystemConfig()).initialBankrollMicros)
            : 0n;

    const liveBaselineEquityMicros =
        tradingMode === TradingMode.LIVE ? await getLiveBaselineEquityMicros() : null;

    const state = await prisma.globalPortfolioState.findUnique({
        where: {
            tradingMode_portfolioScope: {
                tradingMode,
                portfolioScope: PortfolioScope.EXEC_GLOBAL,
            },
        },
        select: { cashMicros: true, contributedCapitalMicros: true },
    });

    const stateCashMicros = state?.cashMicros ?? 0n;
    const paperContributedCapitalMicros =
        tradingMode === TradingMode.PAPER ? state?.contributedCapitalMicros ?? 0n : 0n;

    const positions = await prisma.currentPosition.findMany({
        where: { tradingMode, shareMicros: { not: 0n } },
        select: { assetId: true, shareMicros: true },
    });

    const assetIds = positions.map((pos) => pos.assetId);
    const prices = assetIds.length
        ? await prisma.currentPrice.findMany({
              where: { assetId: { in: assetIds } },
              select: { assetId: true, midpointPriceMicros: true },
          })
        : [];

    const priceByAsset = new Map<string, number>(
        prices.map((row) => [row.assetId, row.midpointPriceMicros])
    );

    let totalPositionValueMicros = 0n;
    for (const pos of positions) {
        const priceMicros = priceByAsset.get(pos.assetId) ?? DEFAULT_MARK_PRICE_MICROS;
        totalPositionValueMicros += (pos.shareMicros * BigInt(priceMicros)) / 1_000_000n;
    }

    const cashMicros = initialBankrollMicros + stateCashMicros;
    const equityMicros = cashMicros + totalPositionValueMicros;

    const contributedCapitalMicros =
        tradingMode === TradingMode.LIVE
            ? liveBaselineEquityMicros ?? equityMicros
            : initialBankrollMicros + paperContributedCapitalMicros;

    const pnlMicros = equityMicros - contributedCapitalMicros;

    return {
        equityMicros,
        contributedCapitalMicros,
        pnlMicros,
        positionCount: positions.length,
    };
}

async function writeEquityPoint(
    granularity: EquityPointGranularity,
    bucketTime: Date,
    equityMicros: bigint,
    contributedCapitalMicros: bigint,
    pnlMicros: bigint,
    tradingMode: TradingMode = TradingMode.PAPER
): Promise<void> {
    await prisma.equityPoint.upsert({
        where: {
            tradingMode_granularity_bucketTime: {
                tradingMode,
                granularity,
                bucketTime,
            },
        },
        create: {
            tradingMode,
            granularity,
            bucketTime,
            equityMicros,
            contributedCapitalMicros,
            pnlMicros,
        },
        update: {
            equityMicros,
            contributedCapitalMicros,
            pnlMicros,
        },
    });
}

async function tickOnce(): Promise<void> {
    if (tickInFlight) {
        logger.warn("Equity point tick already in flight, skipping");
        return;
    }
    tickInFlight = true;

    const now = new Date();
    const nowMs = now.getTime();

    try {
        for (const tradingMode of [TradingMode.PAPER, TradingMode.LIVE]) {
            const snapshot = await computeEquitySnapshot(tradingMode);

            for (const cfg of GRANULARITIES) {
                const bucketTime = getBucketTime(nowMs, cfg.intervalMs);
                const bucketMs = bucketTime.getTime();

                const mapKey = `${tradingMode}:${cfg.granularity}`;

                if (cfg.granularity !== EquityPointGranularity.M1) {
                    if (!isWithinBoundaryWindow(nowMs, cfg.intervalMs, EQUITY_BOUNDARY_WINDOW_MS)) continue;
                    if (lastBucketMsByModeGranularity.get(mapKey) === bucketMs) continue;
                }

                await writeEquityPoint(
                    cfg.granularity,
                    bucketTime,
                    snapshot.equityMicros,
                    snapshot.contributedCapitalMicros,
                    snapshot.pnlMicros,
                    tradingMode
                );

                lastBucketMsByModeGranularity.set(mapKey, bucketMs);
            }

            logger.info(
                {
                    tradingMode,
                    equityMicros: snapshot.equityMicros.toString(),
                    pnlMicros: snapshot.pnlMicros.toString(),
                    positionCount: snapshot.positionCount,
                },
                "Equity point tick complete"
            );
        }
    } catch (err) {
        logger.error({ err }, "Equity point tick failed");
    } finally {
        tickInFlight = false;
    }
}

async function runRetentionOnce(): Promise<void> {
    const log = logger.child({ operation: "retention" });
    const nowMs = Date.now();

    try {
        for (const cfg of GRANULARITIES) {
            if (!cfg.retentionMs) continue;
            const cutoff = new Date(nowMs - cfg.retentionMs);
            for (const tradingMode of [TradingMode.PAPER, TradingMode.LIVE]) {
                const result = await prisma.equityPoint.deleteMany({
                    where: {
                        tradingMode,
                        granularity: cfg.granularity,
                        bucketTime: { lt: cutoff },
                    },
                });
                if (result.count > 0) {
                    log.info(
                        { tradingMode, granularity: cfg.granularity, deleted: result.count },
                        "Deleted old equity points"
                    );
                }
            }
        }
    } catch (err) {
        log.error({ err }, "Equity point retention cleanup failed");
    }
}

export function startEquityPointLoop(): void {
    if (equityTickInterval || equityTickTimeout) {
        logger.warn("Equity point loop already running");
        return;
    }

    logger.info(
        { intervalMs: EQUITY_TICK_INTERVAL_MS, boundaryWindowMs: EQUITY_BOUNDARY_WINDOW_MS },
        "Starting equity point loop"
    );

    const delayMs = EQUITY_TICK_INTERVAL_MS - (Date.now() % EQUITY_TICK_INTERVAL_MS);
    equityTickTimeout = setTimeout(() => {
        equityTickTimeout = null;
        tickOnce().catch((err) => logger.error({ err }, "Initial equity tick failed"));
        equityTickInterval = setInterval(() => {
            tickOnce().catch((err) => logger.error({ err }, "Scheduled equity tick failed"));
        }, EQUITY_TICK_INTERVAL_MS);
    }, delayMs);

    // Retention: run once shortly after startup, then daily.
    retentionTimeout = setTimeout(() => {
        retentionTimeout = null;
        runRetentionOnce().catch((err) => logger.error({ err }, "Initial retention run failed"));
    }, 10_000);
    retentionInterval = setInterval(() => {
        runRetentionOnce().catch((err) => logger.error({ err }, "Scheduled retention run failed"));
    }, 24 * 60 * 60 * 1000);
}

export function stopEquityPointLoop(): void {
    if (equityTickTimeout) {
        clearTimeout(equityTickTimeout);
        equityTickTimeout = null;
    }
    if (equityTickInterval) {
        clearInterval(equityTickInterval);
        equityTickInterval = null;
    }
    if (retentionTimeout) {
        clearTimeout(retentionTimeout);
        retentionTimeout = null;
    }
    if (retentionInterval) {
        clearInterval(retentionInterval);
        retentionInterval = null;
    }
    logger.info("Equity point loop stopped");
}
