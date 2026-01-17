import { TradeSide, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    fetchWalletTrades,
    priceToMicros,
    sharesToMicros,
    usdcToMicros,
    type PolymarketTrade,
} from "../poly/index.js";
import { getLastTradeTime, setLastTradeTime } from "./checkpoint.js";
import { queues } from "../queue/queues.js";
import { setLastCanonicalEventTime } from "../health/server.js";

const logger = createChildLogger({ module: "trade-ingester" });

/**
 * Source identifier for Polymarket API trades.
 */
const SOURCE = "POLYMARKET_API";

/**
 * Convert API trade to database insert data.
 */
function tradeToDbData(
    trade: PolymarketTrade,
    profileWallet: string
): Prisma.TradeEventCreateInput {
    let timestampSeconds: number | null = null;
    if (typeof trade.timestamp === "number") {
        timestampSeconds = trade.timestamp;
    } else if (trade.match_time) {
        const matchMs = new Date(trade.match_time).getTime();
        timestampSeconds = Number.isFinite(matchMs) ? Math.floor(matchMs / 1000) : null;
    }

    if (timestampSeconds == null || !Number.isFinite(timestampSeconds)) {
        throw new Error("Trade missing timestamp");
    }

    const txHash = trade.transactionHash ?? trade.transaction_hash ?? null;
    const assetId = trade.assetId ?? trade.asset ?? trade.asset_id ?? null;
    const marketId = trade.marketId ?? trade.market ?? trade.conditionId ?? null;
    const proxyWalletRaw = trade.proxyWallet ?? trade.owner ?? null;
    const proxyWallet =
        proxyWalletRaw && proxyWalletRaw !== profileWallet ? proxyWalletRaw : null;

    const side = trade.side === "BUY" ? TradeSide.BUY : TradeSide.SELL;
    const shareMicros = sharesToMicros(trade.size);
    const sizeNumberRaw =
        typeof trade.size === "string" ? parseFloat(trade.size) : trade.size;
    const sizeNumber = Number.isFinite(sizeNumberRaw) ? sizeNumberRaw : null;
    const usdcNumberRaw =
        trade.usdcSize != null
            ? typeof trade.usdcSize === "string"
                  ? parseFloat(trade.usdcSize)
                  : trade.usdcSize
            : null;
    const usdcNumber = Number.isFinite(usdcNumberRaw ?? NaN) ? usdcNumberRaw : null;

    let priceMicros: number | null = null;
    if (trade.price != null) {
        priceMicros = priceToMicros(trade.price);
    } else if (usdcNumber != null && sizeNumber && sizeNumber > 0) {
        priceMicros = priceToMicros(usdcNumber / sizeNumber);
    }

    if (priceMicros == null || Number.isNaN(priceMicros)) {
        throw new Error("Trade missing price");
    }

    // Notional = price * shares
    const notionalMicros =
        usdcNumber != null
            ? usdcToMicros(usdcNumber)
            : (BigInt(priceMicros) * shareMicros) / BigInt(1_000_000);

    const sourceId =
        trade.id ??
        `${txHash ?? "unknown"}_${timestampSeconds}_${trade.side}_${assetId ?? "unknown"}_${trade.size}`;

    return {
        source: SOURCE,
        sourceId,
        txHash,
        isCanonical: true,
        profileWallet,
        proxyWallet,
        marketId,
        assetId,
        side,
        priceMicros,
        shareMicros,
        notionalMicros,
        feeMicros: null, // Fee info not always available
        eventTime: new Date(timestampSeconds * 1000),
        detectTime: new Date(),
    };
}

/**
 * Ingest trades for a followed user from Polymarket API.
 * Returns number of new trades inserted.
 */
export async function ingestTradesForUser(
    userId: string,
    walletAddress: string,
    options?: { backfillMinutes?: number }
): Promise<number> {
    const log = logger.child({ userId, wallet: walletAddress });

    // Get last checkpoint or use backfill window
    let afterTime = await getLastTradeTime(userId);
    if (!afterTime && options?.backfillMinutes) {
        afterTime = new Date(Date.now() - options.backfillMinutes * 60 * 1000);
        log.info({ backfillMinutes: options.backfillMinutes }, "Cold start backfill");
    }

    // Fetch trades from API
    const trades = await fetchWalletTrades(walletAddress, {
        after: afterTime ? Math.floor(afterTime.getTime() / 1000).toString() : undefined,
        limit: 100,
    });

    if (trades.length === 0) {
        log.debug("No new trades");
        return 0;
    }

    log.info({ count: trades.length }, "Fetched trades from API");

    let newCount = 0;
    let latestTime: Date | null = null;

    for (const trade of trades) {
        let sourceId: string | null = null;

        // Idempotent upsert
        try {
            const dbData = tradeToDbData(trade, walletAddress);
            const tradeTime =
                dbData.eventTime instanceof Date
                    ? dbData.eventTime
                    : new Date(dbData.eventTime);
            sourceId = dbData.sourceId ?? null;

            // Track latest trade time for checkpoint even if we skip inserting (e.g. already captured via WS).
            if (!latestTime || tradeTime > latestTime) {
                latestTime = tradeTime;
            }

            if (dbData.txHash && dbData.assetId) {
                const existingWs = await prisma.tradeEvent.findFirst({
                    where: {
                        source: "ONCHAIN_WS",
                        txHash: dbData.txHash,
                        profileWallet: walletAddress,
                        side: dbData.side,
                        OR: [{ rawTokenId: dbData.assetId }, { assetId: dbData.assetId }],
                    },
                    select: { id: true, eventTime: true, detectTime: true },
                });

                if (existingWs) {
                    // WS trades are inserted with eventTime = detectTime (no block timestamp lookup).
                    // When the Polymarket API trade arrives, it includes the trade timestamp; use it to
                    // backfill the WS trade's eventTime so detect lag becomes meaningful.
                    const wsEventMs = existingWs.eventTime.getTime();
                    const wsDetectMs = existingWs.detectTime.getTime();
                    const apiEventMs = tradeTime.getTime();
                    if (wsEventMs === wsDetectMs || apiEventMs < wsEventMs) {
                        await prisma.tradeEvent.update({
                            where: { id: existingWs.id },
                            data: { eventTime: tradeTime },
                        });
                    }
                    log.debug(
                        { txHash: dbData.txHash, wsTradeEventId: existingWs.id },
                        "Skipping API trade (already captured via WS)"
                    );
                    continue;
                }
            }

            // Check if already exists
            const existing = await prisma.tradeEvent.findFirst({
                where: {
                    source: SOURCE,
                    sourceId: dbData.sourceId,
                },
            });

            if (existing) {
                log.debug({ sourceId: dbData.sourceId }, "Trade already exists, skipping");
                continue;
            }

            // Insert new trade
            const inserted = await prisma.tradeEvent.create({
                data: dbData,
            });

            newCount++;
            log.debug({ tradeId: inserted.id }, "Inserted new trade");

            // Enqueue for processing (shadow ledger, aggregation, etc.)
            await queues.ingestEvents.add("process-trade", {
                tradeEventId: inserted.id,
                followedUserId: userId,
            });

            // Update health status
            setLastCanonicalEventTime(tradeTime);
        } catch (err) {
            // Handle unique constraint violations gracefully
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2002"
            ) {
                log.debug(
                    { sourceId: sourceId ?? trade.transactionHash ?? "unknown" },
                    "Trade already exists (constraint)"
                );
                continue;
            }
            throw err;
        }
    }

    // Update checkpoint
    if (latestTime) {
        await setLastTradeTime(userId, latestTime);
    }

    log.info({ newCount, total: trades.length }, "Trade ingestion complete");
    return newCount;
}

/**
 * Small delay between wallet fetches to spread API load.
 */
const WALLET_FETCH_DELAY_MS = 200;

/**
 * Ingest trades for all enabled followed users.
 */
export async function ingestAllUserTrades(options?: {
    backfillMinutes?: number;
}): Promise<void> {
    const users = await prisma.followedUser.findMany({
        where: { enabled: true },
    });

    logger.info({ userCount: users.length }, "Starting trade ingestion for all users");

    for (const user of users) {
        try {
            await ingestTradesForUser(user.id, user.profileWallet, options);
            // Small delay between wallets to spread API load
            await new Promise((resolve) => setTimeout(resolve, WALLET_FETCH_DELAY_MS));
        } catch (err) {
            logger.error(
                { err, userId: user.id, wallet: user.profileWallet },
                "Failed to ingest trades for user"
            );
        }
    }
}

/**
 * Fast trade ingestion for a single wallet, triggered by Alchemy detection.
 * Returns the number of new trades and latency metrics.
 *
 * This is optimized for the reconcile flow:
 * - Only looks back 5 minutes by default
 * - Returns timing info for latency tracking
 */
export async function ingestTradesForWalletFast(
    walletAddress: string,
    options?: {
        afterTime?: Date;
        alchemyDetectTime?: Date;
    }
): Promise<{ newCount: number; latencyMs: number }> {
    const log = logger.child({ wallet: walletAddress, fast: true });
    const fetchStart = Date.now();

    // Look back 5 minutes by default for fast reconcile
    const afterTime = options?.afterTime ?? new Date(Date.now() - 5 * 60 * 1000);

    // Look up user by wallet
    const followedUser = await prisma.followedUser.findUnique({
        where: { profileWallet: walletAddress },
    });

    if (!followedUser) {
        // Try to find by proxy wallet
        const proxyRecord = await prisma.followedUserProxyWallet.findUnique({
            where: { wallet: walletAddress },
            include: { followedUser: true },
        });

        if (!proxyRecord?.followedUser) {
            log.warn("Wallet not found in followed users");
            return { newCount: 0, latencyMs: Date.now() - fetchStart };
        }

        // Use the profile wallet for fetching
        return ingestTradesForWalletFast(proxyRecord.followedUser.profileWallet, options);
    }

    // Fetch trades from API
    const trades = await fetchWalletTrades(walletAddress, {
        after: Math.floor(afterTime.getTime() / 1000).toString(),
        limit: 50, // Smaller limit for fast reconcile
    });

    if (trades.length === 0) {
        log.debug("No new trades in fast fetch");
        return { newCount: 0, latencyMs: Date.now() - fetchStart };
    }

    log.debug({ count: trades.length }, "Fast fetched trades from API");

    let newCount = 0;

    for (const trade of trades) {
        let sourceId: string | null = null;

        try {
            const dbData = tradeToDbData(trade, walletAddress);
            const tradeTime =
                dbData.eventTime instanceof Date
                    ? dbData.eventTime
                    : new Date(dbData.eventTime);
            sourceId = dbData.sourceId ?? null;

            if (dbData.txHash && dbData.assetId) {
                const existingWs = await prisma.tradeEvent.findFirst({
                    where: {
                        source: "ONCHAIN_WS",
                        txHash: dbData.txHash,
                        profileWallet: walletAddress,
                        side: dbData.side,
                        OR: [{ rawTokenId: dbData.assetId }, { assetId: dbData.assetId }],
                    },
                    select: { id: true, eventTime: true, detectTime: true },
                });

                if (existingWs) {
                    const wsEventMs = existingWs.eventTime.getTime();
                    const wsDetectMs = existingWs.detectTime.getTime();
                    const apiEventMs = tradeTime.getTime();
                    if (wsEventMs === wsDetectMs || apiEventMs < wsEventMs) {
                        await prisma.tradeEvent.update({
                            where: { id: existingWs.id },
                            data: { eventTime: tradeTime },
                        });
                    }
                    log.debug(
                        { txHash: dbData.txHash, wsTradeEventId: existingWs.id },
                        "Skipping API trade (already captured via WS)"
                    );
                    continue;
                }
            }

            // Check if already exists
            const existing = await prisma.tradeEvent.findFirst({
                where: {
                    source: SOURCE,
                    sourceId: dbData.sourceId,
                },
            });

            if (existing) {
                log.debug({ sourceId: dbData.sourceId }, "Trade already exists, skipping");
                continue;
            }

            // Insert new trade
            const inserted = await prisma.tradeEvent.create({
                data: dbData,
            });

            newCount++;
            log.debug({ tradeId: inserted.id }, "Fast inserted new trade");

            // Enqueue for processing (shadow ledger, aggregation, etc.)
            await queues.ingestEvents.add("process-trade", {
                tradeEventId: inserted.id,
                followedUserId: followedUser.id,
            });

            // Update health status
            setLastCanonicalEventTime(tradeTime);
        } catch (err) {
            // Handle unique constraint violations gracefully
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2002"
            ) {
                log.debug(
                    { sourceId: sourceId ?? trade.transactionHash ?? "unknown" },
                    "Trade already exists (constraint)"
                );
                continue;
            }
            throw err;
        }
    }

    const latencyMs = Date.now() - fetchStart;
    log.info({ newCount, total: trades.length, latencyMs }, "Fast trade ingestion complete");

    return { newCount, latencyMs };
}

/**
 * Discover and save proxy wallets from trades.
 */
export async function discoverProxyWallets(): Promise<void> {
    // Find trades where proxyWallet is set but not in our proxy table
    const tradesWithProxies = await prisma.tradeEvent.findMany({
        where: {
            proxyWallet: { not: null },
        },
        select: {
            profileWallet: true,
            proxyWallet: true,
        },
        distinct: ["proxyWallet"],
    });

    for (const trade of tradesWithProxies) {
        if (!trade.proxyWallet) continue;

        // Find the followed user by profile wallet
        const followedUser = await prisma.followedUser.findUnique({
            where: { profileWallet: trade.profileWallet },
        });

        if (!followedUser) continue;

        // Upsert proxy wallet
        await prisma.followedUserProxyWallet.upsert({
            where: { wallet: trade.proxyWallet },
            create: {
                followedUserId: followedUser.id,
                wallet: trade.proxyWallet,
            },
            update: {},
        });

        logger.debug(
            { userId: followedUser.id, proxy: trade.proxyWallet },
            "Discovered proxy wallet"
        );
    }
}
