import { PortfolioScope, LedgerEntryType, TradeSide, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "shadow-ledger" });

/**
 * Apply a trade event to the shadow ledger for a followed user.
 * Creates a SHADOW_USER ledger entry that exactly mirrors the leader's trade.
 */
export async function applyShadowTrade(
    tradeEventId: string,
    followedUserId: string
): Promise<void> {
    const log = logger.child({ tradeEventId, followedUserId });

    // Fetch the trade event
    const trade = await prisma.tradeEvent.findUnique({
        where: { id: tradeEventId },
    });

    if (!trade) {
        log.error("Trade event not found");
        throw new Error(`Trade event not found: ${tradeEventId}`);
    }

    if (!trade.isCanonical) {
        log.debug("Skipping non-canonical trade");
        return;
    }

    // Compute ledger entry values
    // BUY: +shares, -cash (spending USDC to buy shares)
    // SELL: -shares, +cash (selling shares for USDC)
    const isBuy = trade.side === TradeSide.BUY;
    const shareDeltaMicros = isBuy ? trade.shareMicros : -trade.shareMicros;
    const cashDeltaMicros = isBuy ? -trade.notionalMicros : trade.notionalMicros;

    // Unique ref for idempotency
    const refId = `trade:${trade.id}`;

    try {
        // Upsert to ensure idempotency
        await prisma.ledgerEntry.upsert({
            where: {
                portfolioScope_refId_entryType: {
                    portfolioScope: PortfolioScope.SHADOW_USER,
                    refId,
                    entryType: LedgerEntryType.TRADE_FILL,
                },
            },
            create: {
                portfolioScope: PortfolioScope.SHADOW_USER,
                followedUserId,
                marketId: trade.marketId,
                assetId: trade.assetId,
                entryType: LedgerEntryType.TRADE_FILL,
                shareDeltaMicros,
                cashDeltaMicros,
                priceMicros: trade.priceMicros,
                refId,
            },
            update: {
                // No update needed - if exists, it's already correct
            },
        });

        log.debug(
            { side: trade.side, shareDelta: shareDeltaMicros.toString(), cashDelta: cashDeltaMicros.toString() },
            "Applied shadow ledger entry"
        );
    } catch (err) {
        if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
        ) {
            log.debug("Ledger entry already exists (constraint)");
            return;
        }
        throw err;
    }
}

/**
 * Get current position for an asset in shadow portfolio.
 */
export async function getShadowPosition(
    followedUserId: string,
    assetId: string
): Promise<bigint> {
    const result = await prisma.ledgerEntry.aggregate({
        where: {
            portfolioScope: PortfolioScope.SHADOW_USER,
            followedUserId,
            assetId,
        },
        _sum: {
            shareDeltaMicros: true,
        },
    });

    return result._sum.shareDeltaMicros ?? BigInt(0);
}

/**
 * Get total cash for shadow portfolio.
 */
export async function getShadowCash(followedUserId: string): Promise<bigint> {
    const result = await prisma.ledgerEntry.aggregate({
        where: {
            portfolioScope: PortfolioScope.SHADOW_USER,
            followedUserId,
        },
        _sum: {
            cashDeltaMicros: true,
        },
    });

    return result._sum.cashDeltaMicros ?? BigInt(0);
}

/**
 * Get all positions for shadow portfolio.
 */
export async function getShadowPositions(
    followedUserId: string
): Promise<Map<string, bigint>> {
    const entries = await prisma.ledgerEntry.groupBy({
        by: ["assetId"],
        where: {
            portfolioScope: PortfolioScope.SHADOW_USER,
            followedUserId,
            assetId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
        },
    });

    const positions = new Map<string, bigint>();
    for (const entry of entries) {
        if (entry.assetId && entry._sum.shareDeltaMicros) {
            positions.set(entry.assetId, entry._sum.shareDeltaMicros);
        }
    }

    return positions;
}
