/**
 * Portfolio snapshot loop.
 *
 * Every minute, compute snapshots for:
 * - Global executable (EXEC_GLOBAL)
 * - Each per-user shadow (SHADOW_USER)
 *
 * Uses incremental computation:
 * - Start from last snapshot
 * - Apply ledger entries since last snapshot
 */

import { LedgerEntryType, PortfolioScope } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { getLatestPrices } from "./prices.js";
import { getSystemConfig } from "../config/system.js";

const logger = createChildLogger({ module: "portfolio-snapshot" });

/** Snapshot interval in milliseconds (1 minute per spec). */
const SNAPSHOT_INTERVAL_MS = 60_000;

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Get the minute bucket time for a given timestamp.
 */
function getBucketTime(timestamp: Date): Date {
    const ms = timestamp.getTime();
    const bucketMs = Math.floor(ms / SNAPSHOT_INTERVAL_MS) * SNAPSHOT_INTERVAL_MS;
    return new Date(bucketMs);
}

/**
 * Position data for a portfolio.
 */
interface Position {
    assetId: string;
    shareMicros: bigint;
    costBasisMicros: bigint;
}

/**
 * Get current positions for a portfolio.
 */
async function getPositions(
    scope: PortfolioScope,
    followedUserId: string | null
): Promise<Position[]> {
    // Aggregate ledger entries by asset
    const entries = await prisma.ledgerEntry.groupBy({
        by: ["assetId"],
        where: {
            portfolioScope: scope,
            ...(scope === PortfolioScope.EXEC_GLOBAL && followedUserId === null
                ? {}
                : { followedUserId }),
            assetId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
            cashDeltaMicros: true,
        },
    });

    const positions: Position[] = [];
    for (const entry of entries) {
        if (!entry.assetId) continue;

        const shareMicros = entry._sum.shareDeltaMicros ?? BigInt(0);
        if (shareMicros === BigInt(0)) continue; // No position

        // Cost basis is the negative of cash delta (cash spent = cost)
        const costBasisMicros = -(entry._sum.cashDeltaMicros ?? BigInt(0));

        positions.push({
            assetId: entry.assetId,
            shareMicros,
            costBasisMicros,
        });
    }

    return positions;
}

/**
 * Get total cash balance for a portfolio.
 */
async function getCashBalance(
    scope: PortfolioScope,
    followedUserId: string | null,
    initialCashMicros: bigint
): Promise<bigint> {
    // Sum all cash deltas
    const result = await prisma.ledgerEntry.aggregate({
        where: {
            portfolioScope: scope,
            ...(scope === PortfolioScope.EXEC_GLOBAL && followedUserId === null
                ? {}
                : { followedUserId }),
        },
        _sum: {
            cashDeltaMicros: true,
        },
    });

    return initialCashMicros + (result._sum.cashDeltaMicros ?? BigInt(0));
}

/**
 * Get net external cash flows (deposits/withdrawals) for a portfolio.
 *
 * Today we only support DEPOSIT into EXEC_GLOBAL via the web API.
 * These are equity-neutral contributions and should not be counted as PnL.
 */
async function getNetExternalFlows(
    scope: PortfolioScope,
    followedUserId: string | null
): Promise<bigint> {
    const result = await prisma.ledgerEntry.aggregate({
        where: {
            portfolioScope: scope,
            ...(scope === PortfolioScope.EXEC_GLOBAL && followedUserId === null
                ? {}
                : { followedUserId }),
            assetId: null,
            entryType: LedgerEntryType.DEPOSIT,
        },
        _sum: { cashDeltaMicros: true },
    });

    return result._sum?.cashDeltaMicros ?? BigInt(0);
}

/**
 * Compute and write snapshot for a single portfolio.
 */
async function computePortfolioSnapshot(
    scope: PortfolioScope,
    followedUserId: string | null,
    bucketTime: Date
): Promise<void> {
    const log = logger.child({ scope, followedUserId });

    try {
        // Get positions
        const positions = await getPositions(scope, followedUserId);

        // Get asset prices
        const assetIds = positions.map((p) => p.assetId);
        const prices = await getLatestPrices(assetIds);

        // Calculate position values and exposure
        let totalExposureMicros = BigInt(0);
        let totalPositionValueMicros = BigInt(0);
        let totalUnrealizedPnlMicros = BigInt(0);

        for (const pos of positions) {
            const priceMicros = prices.get(pos.assetId) ?? 500_000; // Default 0.50 if no price

            // Position value = shares * price (both in micros, so divide by 1M)
            const positionValueMicros =
                (pos.shareMicros * BigInt(priceMicros)) / BigInt(1_000_000);

            // Exposure is absolute value of position
            const absValue = positionValueMicros < BigInt(0) ? -positionValueMicros : positionValueMicros;
            totalExposureMicros += absValue;

            // Net position value contributes to equity
            totalPositionValueMicros += positionValueMicros;

            // Unrealized PnL = current value - cost basis
            totalUnrealizedPnlMicros += positionValueMicros - pos.costBasisMicros;
        }

        // Initial capital: global EXEC starts from configured bankroll; user-attribution
        // slices start from 0 (their slice net value).
        let initialCashMicros = BigInt(100_000_000_000); // Default 100k USDC
        if (scope === PortfolioScope.EXEC_GLOBAL) {
            if (followedUserId !== null) {
                initialCashMicros = BigInt(0);
            } else {
                const system = await getSystemConfig();
                initialCashMicros = BigInt(system.initialBankrollMicros);
            }
        }

        // Get cash balance
        const cashMicros = await getCashBalance(scope, followedUserId, initialCashMicros);

        // Equity = cash + net position value
        const equityMicros = cashMicros + totalPositionValueMicros;

        // Total PnL should always reconcile to equity - initial capital.
        // If we injected additional capital (deposits), exclude that from PnL.
        const netExternalFlowsMicros = await getNetExternalFlows(scope, followedUserId);
        const contributedCapitalMicros = initialCashMicros + netExternalFlowsMicros;

        // Realized PnL is the remainder after subtracting unrealized PnL from total PnL.
        const totalPnlMicros = equityMicros - contributedCapitalMicros;
        const realizedPnlMicros = totalPnlMicros - totalUnrealizedPnlMicros;

        // Write snapshot - handle null followedUserId specially for Prisma compound unique
        const snapshotData = {
            portfolioScope: scope,
            followedUserId,
            bucketTime,
            equityMicros,
            cashMicros,
            exposureMicros: totalExposureMicros,
            unrealizedPnlMicros: totalUnrealizedPnlMicros,
            realizedPnlMicros,
        };

        if (followedUserId !== null) {
            await prisma.portfolioSnapshot.upsert({
                where: {
                    portfolioScope_followedUserId_bucketTime: {
                        portfolioScope: scope,
                        followedUserId,
                        bucketTime,
                    },
                },
                create: snapshotData,
                update: {
                    equityMicros,
                    cashMicros,
                    exposureMicros: totalExposureMicros,
                    unrealizedPnlMicros: totalUnrealizedPnlMicros,
                    realizedPnlMicros,
                },
            });
        } else {
            // Postgres UNIQUE constraints allow multiple NULLs; keep writes stable if duplicates exist.
            const result = await prisma.portfolioSnapshot.updateMany({
                where: {
                    portfolioScope: scope,
                    followedUserId: null,
                    bucketTime,
                },
                data: {
                    equityMicros,
                    cashMicros,
                    exposureMicros: totalExposureMicros,
                    unrealizedPnlMicros: totalUnrealizedPnlMicros,
                    realizedPnlMicros,
                },
            });

            if (result.count === 0) {
                await prisma.portfolioSnapshot.create({
                    data: snapshotData,
                });
            }
        }

        log.debug(
            {
                equity: equityMicros.toString(),
                cash: cashMicros.toString(),
                exposure: totalExposureMicros.toString(),
                positionCount: positions.length,
            },
            "Portfolio snapshot written"
        );
    } catch (err) {
        log.error({ err }, "Failed to compute portfolio snapshot");
    }
}

/**
 * Compute snapshots for all portfolios.
 */
async function computeAllSnapshots(): Promise<void> {
    const log = logger.child({ operation: "compute-all" });
    const bucketTime = getBucketTime(new Date());

    try {
        // 1. Global executable
        await computePortfolioSnapshot(PortfolioScope.EXEC_GLOBAL, null, bucketTime);

        // 2. Get all followed users
        const followedUsers = await prisma.followedUser.findMany({
            where: { enabled: true },
            select: { id: true },
        });

        // 3. Per-user shadow
        for (const user of followedUsers) {
            await computePortfolioSnapshot(PortfolioScope.EXEC_GLOBAL, user.id, bucketTime);
            await computePortfolioSnapshot(PortfolioScope.SHADOW_USER, user.id, bucketTime);
        }

        log.info(
            { userCount: followedUsers.length, bucketTime },
            "All portfolio snapshots computed"
        );
    } catch (err) {
        log.error({ err }, "Failed to compute all snapshots");
    }
}

/**
 * Start the portfolio snapshot loop.
 */
export function startPortfolioSnapshotLoop(): void {
    if (snapshotTimer) {
        logger.warn("Portfolio snapshot loop already running");
        return;
    }

    logger.info(
        { intervalMs: SNAPSHOT_INTERVAL_MS },
        "Starting portfolio snapshot loop"
    );

    // Run immediately, then on interval
    computeAllSnapshots().catch((err) => {
        logger.error({ err }, "Initial snapshot computation failed");
    });

    snapshotTimer = setInterval(() => {
        computeAllSnapshots().catch((err) => {
            logger.error({ err }, "Scheduled snapshot computation failed");
        });
    }, SNAPSHOT_INTERVAL_MS);
}

/**
 * Stop the portfolio snapshot loop.
 */
export function stopPortfolioSnapshotLoop(): void {
    if (snapshotTimer) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
        logger.info("Portfolio snapshot loop stopped");
    }
}

/**
 * Get the latest snapshot for a portfolio.
 */
export async function getLatestSnapshot(
    scope: PortfolioScope,
    followedUserId: string | null
) {
    return prisma.portfolioSnapshot.findFirst({
        where: {
            portfolioScope: scope,
            followedUserId:
                scope === PortfolioScope.EXEC_GLOBAL && followedUserId === null
                    ? null
                    : followedUserId,
        },
        orderBy: { bucketTime: "desc" },
    });
}

/**
 * Manually trigger a snapshot computation (e.g., after a copy attempt).
 */
export async function triggerSnapshot(
    scope: PortfolioScope,
    followedUserId: string | null
): Promise<void> {
    const bucketTime = getBucketTime(new Date());
    await computePortfolioSnapshot(scope, followedUserId, bucketTime);
}
