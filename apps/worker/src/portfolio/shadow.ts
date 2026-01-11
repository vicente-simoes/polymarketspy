import { PortfolioScope, LedgerEntryType, TradeSide, ActivityType, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import type { ActivityPayload } from "../poly/types.js";

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
 * Apply an activity event (MERGE/SPLIT/REDEEM) to the shadow ledger.
 * Creates ledger entries that exactly mirror the leader's activity.
 *
 * MERGE: User burns YES + NO tokens, receives collateral (USDC)
 *   - For each asset: -shares
 *   - +cash (collateral amount)
 *
 * SPLIT: User burns collateral, receives YES + NO token pairs
 *   - -cash (collateral amount)
 *   - For each asset: +shares
 *
 * REDEEM: User burns winning tokens, receives collateral
 *   - For winning asset: -shares
 *   - +cash
 */
export async function applyShadowActivity(
    activityEventId: string,
    followedUserId: string
): Promise<void> {
    const log = logger.child({ activityEventId, followedUserId });

    // Fetch the activity event
    const activity = await prisma.activityEvent.findUnique({
        where: { id: activityEventId },
    });

    if (!activity) {
        log.error("Activity event not found");
        throw new Error(`Activity event not found: ${activityEventId}`);
    }

    if (!activity.isCanonical) {
        log.debug("Skipping non-canonical activity");
        return;
    }

    const payload = activity.payloadJson as unknown as ActivityPayload;
    if (!payload || !payload.assets || payload.assets.length === 0) {
        log.warn("Activity has no asset data, skipping");
        return;
    }

    // Determine entry type based on activity type
    let entryType: LedgerEntryType;
    switch (activity.type) {
        case ActivityType.MERGE:
            entryType = LedgerEntryType.MERGE;
            break;
        case ActivityType.SPLIT:
            entryType = LedgerEntryType.SPLIT;
            break;
        case ActivityType.REDEEM:
            entryType = LedgerEntryType.SETTLEMENT;
            break;
        default:
            log.warn({ type: activity.type }, "Unknown activity type, skipping");
            return;
    }

    // Base ref for idempotency
    const baseRefId = `activity:${activity.id}`;

    try {
        // Process based on activity type
        if (activity.type === ActivityType.MERGE) {
            // MERGE: Burn tokens, receive collateral
            // Create ledger entry for each asset burned
            for (const asset of payload.assets) {
                const shareDeltaMicros = -BigInt(asset.amountMicros); // Negative - burning tokens

                await prisma.ledgerEntry.upsert({
                    where: {
                        portfolioScope_refId_entryType: {
                            portfolioScope: PortfolioScope.SHADOW_USER,
                            refId: `${baseRefId}:${asset.assetId}`,
                            entryType,
                        },
                    },
                    create: {
                        portfolioScope: PortfolioScope.SHADOW_USER,
                        followedUserId,
                        marketId: null, // Not always available
                        assetId: asset.assetId,
                        entryType,
                        shareDeltaMicros,
                        cashDeltaMicros: BigInt(0), // Cash handled separately
                        priceMicros: null,
                        refId: `${baseRefId}:${asset.assetId}`,
                    },
                    update: {},
                });
            }

            // Create ledger entry for collateral received
            if (payload.collateralAmountMicros) {
                const cashDeltaMicros = BigInt(payload.collateralAmountMicros);
                await prisma.ledgerEntry.upsert({
                    where: {
                        portfolioScope_refId_entryType: {
                            portfolioScope: PortfolioScope.SHADOW_USER,
                            refId: `${baseRefId}:collateral`,
                            entryType,
                        },
                    },
                    create: {
                        portfolioScope: PortfolioScope.SHADOW_USER,
                        followedUserId,
                        marketId: null,
                        assetId: null,
                        entryType,
                        shareDeltaMicros: BigInt(0),
                        cashDeltaMicros,
                        priceMicros: null,
                        refId: `${baseRefId}:collateral`,
                    },
                    update: {},
                });
            }

            log.debug(
                { assetCount: payload.assets.length, collateral: payload.collateralAmountMicros },
                "Applied MERGE to shadow ledger"
            );
        } else if (activity.type === ActivityType.SPLIT) {
            // SPLIT: Burn collateral, receive tokens
            // Create ledger entry for collateral burned
            if (payload.collateralAmountMicros) {
                const cashDeltaMicros = -BigInt(payload.collateralAmountMicros);
                await prisma.ledgerEntry.upsert({
                    where: {
                        portfolioScope_refId_entryType: {
                            portfolioScope: PortfolioScope.SHADOW_USER,
                            refId: `${baseRefId}:collateral`,
                            entryType,
                        },
                    },
                    create: {
                        portfolioScope: PortfolioScope.SHADOW_USER,
                        followedUserId,
                        marketId: null,
                        assetId: null,
                        entryType,
                        shareDeltaMicros: BigInt(0),
                        cashDeltaMicros,
                        priceMicros: null,
                        refId: `${baseRefId}:collateral`,
                    },
                    update: {},
                });
            }

            // Create ledger entry for each asset received
            for (const asset of payload.assets) {
                const shareDeltaMicros = BigInt(asset.amountMicros); // Positive - receiving tokens

                await prisma.ledgerEntry.upsert({
                    where: {
                        portfolioScope_refId_entryType: {
                            portfolioScope: PortfolioScope.SHADOW_USER,
                            refId: `${baseRefId}:${asset.assetId}`,
                            entryType,
                        },
                    },
                    create: {
                        portfolioScope: PortfolioScope.SHADOW_USER,
                        followedUserId,
                        marketId: null,
                        assetId: asset.assetId,
                        entryType,
                        shareDeltaMicros,
                        cashDeltaMicros: BigInt(0),
                        priceMicros: null,
                        refId: `${baseRefId}:${asset.assetId}`,
                    },
                    update: {},
                });
            }

            log.debug(
                { assetCount: payload.assets.length, collateral: payload.collateralAmountMicros },
                "Applied SPLIT to shadow ledger"
            );
        } else if (activity.type === ActivityType.REDEEM) {
            // REDEEM: Burn winning tokens, receive collateral
            // Similar to MERGE but typically for settled markets
            for (const asset of payload.assets) {
                const shareDeltaMicros = -BigInt(asset.amountMicros);

                await prisma.ledgerEntry.upsert({
                    where: {
                        portfolioScope_refId_entryType: {
                            portfolioScope: PortfolioScope.SHADOW_USER,
                            refId: `${baseRefId}:${asset.assetId}`,
                            entryType,
                        },
                    },
                    create: {
                        portfolioScope: PortfolioScope.SHADOW_USER,
                        followedUserId,
                        marketId: null,
                        assetId: asset.assetId,
                        entryType,
                        shareDeltaMicros,
                        cashDeltaMicros: BigInt(0),
                        priceMicros: null,
                        refId: `${baseRefId}:${asset.assetId}`,
                    },
                    update: {},
                });
            }

            // Collateral received from redemption
            if (payload.collateralAmountMicros) {
                const cashDeltaMicros = BigInt(payload.collateralAmountMicros);
                await prisma.ledgerEntry.upsert({
                    where: {
                        portfolioScope_refId_entryType: {
                            portfolioScope: PortfolioScope.SHADOW_USER,
                            refId: `${baseRefId}:collateral`,
                            entryType,
                        },
                    },
                    create: {
                        portfolioScope: PortfolioScope.SHADOW_USER,
                        followedUserId,
                        marketId: null,
                        assetId: null,
                        entryType,
                        shareDeltaMicros: BigInt(0),
                        cashDeltaMicros,
                        priceMicros: null,
                        refId: `${baseRefId}:collateral`,
                    },
                    update: {},
                });
            }

            log.debug(
                { assetCount: payload.assets.length, collateral: payload.collateralAmountMicros },
                "Applied REDEEM to shadow ledger"
            );
        }
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
