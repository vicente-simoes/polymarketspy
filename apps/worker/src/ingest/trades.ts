import { TradeSide, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    fetchWalletTrades,
    priceToMicros,
    sharesToMicros,
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
    followedUserId: string
): Prisma.TradeEventCreateInput {
    const side = trade.side === "BUY" ? TradeSide.BUY : TradeSide.SELL;
    const priceMicros = priceToMicros(trade.price);
    const shareMicros = sharesToMicros(trade.size);
    // Notional = price * shares
    const notionalMicros =
        (BigInt(priceMicros) * shareMicros) / BigInt(1_000_000);

    return {
        source: SOURCE,
        sourceId: trade.id,
        txHash: trade.transaction_hash,
        isCanonical: true,
        profileWallet: trade.maker_address, // The followed wallet
        proxyWallet: trade.owner !== trade.maker_address ? trade.owner : null,
        marketId: trade.market,
        assetId: trade.asset_id,
        side,
        priceMicros,
        shareMicros,
        notionalMicros,
        feeMicros: null, // Fee info not always available
        eventTime: new Date(trade.match_time),
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
        after: afterTime?.toISOString(),
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
        const tradeTime = new Date(trade.match_time);

        // Track latest trade time for checkpoint
        if (!latestTime || tradeTime > latestTime) {
            latestTime = tradeTime;
        }

        // Idempotent upsert
        try {
            const dbData = tradeToDbData(trade, userId);

            // Check if already exists
            const existing = await prisma.tradeEvent.findFirst({
                where: {
                    source: SOURCE,
                    sourceId: trade.id,
                },
            });

            if (existing) {
                log.debug({ tradeId: trade.id }, "Trade already exists, skipping");
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
                log.debug({ tradeId: trade.id }, "Trade already exists (constraint)");
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
        } catch (err) {
            logger.error(
                { err, userId: user.id, wallet: user.profileWallet },
                "Failed to ingest trades for user"
            );
        }
    }
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
