import { TradeSide, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    fetchWalletTrades,
    fetchAllWalletTrades,
    priceToMicros,
    sharesToMicros,
    usdcToMicros,
    type PolymarketTrade,
	} from "../poly/index.js";
import { fetchTokenMetadata } from "../enrichment/gamma.js";
import {
    clearTradeIngestCursor,
    getLastTradeTime,
    getTradeIngestCursor,
    setLastTradeTime,
    setTradeIngestCursor,
} from "./checkpoint.js";
import { queues } from "../queue/queues.js";
import { setLastCanonicalEventTime } from "../health/server.js";

const logger = createChildLogger({ module: "trade-ingester" });

/**
 * Source identifier for Polymarket API trades.
 */
const SOURCE = "POLYMARKET_API";

async function ensureTokenMetadataCached(tokenIds: string[]): Promise<void> {
    const uniqueTokenIds = Array.from(new Set(tokenIds)).filter((id) => /^\d+$/.test(id));
    if (uniqueTokenIds.length === 0) return;

    const cached = await prisma.tokenMetadataCache.findMany({
        where: { tokenId: { in: uniqueTokenIds } },
        select: { tokenId: true, marketTitle: true },
    });
    const cachedSet = new Set(
        cached.filter((c) => c.marketTitle).map((c) => c.tokenId)
    );
    const missing = uniqueTokenIds.filter((id) => !cachedSet.has(id));
    if (missing.length === 0) return;

    try {
        const fetched = await fetchTokenMetadata(missing);
        for (const [tokenId, metadata] of fetched) {
            await prisma.tokenMetadataCache.upsert({
                where: { tokenId },
                create: {
                    tokenId: metadata.tokenId,
                    conditionId: metadata.conditionId,
                    marketId: metadata.marketId,
                    marketSlug: metadata.marketSlug,
                    outcomeLabel: metadata.outcomeLabel,
                    marketTitle: metadata.marketTitle,
                    closeTime: metadata.closeTime,
                },
                update: {
                    conditionId: metadata.conditionId,
                    marketId: metadata.marketId,
                    marketSlug: metadata.marketSlug,
                    outcomeLabel: metadata.outcomeLabel,
                    marketTitle: metadata.marketTitle,
                    closeTime: metadata.closeTime,
                },
            });
        }
    } catch (err) {
        logger.warn({ err }, "Failed to prefetch token metadata during trade ingest");
    }
}

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
    // marketId should only contain the Polymarket market id (not conditionId).
    const marketId = trade.marketId ?? trade.market ?? null;
    const conditionId = trade.conditionId ?? null;
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
        conditionId,
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

    const existingCursor = await getTradeIngestCursor(userId);
    const checkpointAfterTime = await getLastTradeTime(userId);
    const checkpointAfterSeconds = checkpointAfterTime
        ? Math.floor(checkpointAfterTime.getTime() / 1000)
        : null;

    if (
        existingCursor &&
        checkpointAfterSeconds != null &&
        existingCursor.afterSeconds !== checkpointAfterSeconds
    ) {
        log.warn(
            { checkpointAfterSeconds, cursorAfterSeconds: existingCursor.afterSeconds },
            "Discarding stale trade ingest cursor (after changed)"
        );
        await clearTradeIngestCursor(userId);
    }

    const cursor = await getTradeIngestCursor(userId);

    // Determine the effective "after" window. Always bound the window to avoid accidentally
    // backfilling an entire wallet history when no checkpoint exists.
    let afterSeconds: number | undefined;
    let resumeBeforeSeconds: number | undefined;
    let sessionMaxSeenSeconds: number | undefined = cursor?.maxSeenSeconds;

    if (cursor) {
        afterSeconds = cursor.afterSeconds;
        resumeBeforeSeconds = cursor.beforeSeconds;
    } else if (checkpointAfterSeconds != null) {
        afterSeconds = checkpointAfterSeconds;
    } else {
        const backfillMinutes = options?.backfillMinutes ?? 15;
        afterSeconds = Math.floor(
            (Date.now() - backfillMinutes * 60 * 1000) / 1000
        );
        log.info({ backfillMinutes }, "No trade checkpoint found; using bounded backfill window");
    }

    // Fetch ALL trades from API with pagination to avoid missing trades
    // during high-activity windows (e.g., >100 trades in catch-up period)
    const tradeFetch = await fetchAllWalletTrades(walletAddress, {
        after: afterSeconds != null ? afterSeconds.toString() : undefined,
        before: resumeBeforeSeconds != null ? resumeBeforeSeconds.toString() : undefined,
        maxPages: 10, // Safety limit: max 1000 trades per ingestion cycle
        pageSize: 100,
    });
    const trades = tradeFetch.items;

    if (trades.length === 0) {
        log.debug(
            {
                exhausted: tradeFetch.exhausted,
                hitMaxPages: tradeFetch.hitMaxPages,
                stalled: tradeFetch.stalled,
                pagesFetched: tradeFetch.pagesFetched,
            },
            "No trades returned from API"
        );
    } else {
        log.info(
            {
                count: trades.length,
                exhausted: tradeFetch.exhausted,
                hitMaxPages: tradeFetch.hitMaxPages,
                stalled: tradeFetch.stalled,
                pagesFetched: tradeFetch.pagesFetched,
            },
            "Fetched trades from API (paginated)"
        );
    }

    if (trades.length > 0) {
        // Prefetch token metadata so API-caught trades show market/outcome on the dashboard.
        await ensureTokenMetadataCached(
            trades
                .map((trade) => trade.assetId ?? trade.asset ?? trade.asset_id ?? null)
                .filter((id): id is string => Boolean(id))
        );
    }

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

    const latestSeconds =
        latestTime != null ? Math.floor(latestTime.getTime() / 1000) : undefined;
    if (latestSeconds != null) {
        sessionMaxSeenSeconds = sessionMaxSeenSeconds == null
            ? latestSeconds
            : Math.max(sessionMaxSeenSeconds, latestSeconds);
    }

    if (tradeFetch.exhausted) {
        // Only advance the "last trade time" checkpoint when we've exhausted pagination.
        // If pagination is incomplete, advancing this checkpoint can permanently skip older trades.
        if (sessionMaxSeenSeconds != null) {
            await setLastTradeTime(userId, new Date(sessionMaxSeenSeconds * 1000));
        }
        await clearTradeIngestCursor(userId);
    } else if (tradeFetch.stalled) {
        log.error(
            {
                afterSeconds,
                beforeSeconds: resumeBeforeSeconds,
                pagesFetched: tradeFetch.pagesFetched,
            },
            "Trade pagination stalled; not advancing checkpoint (will retry next cycle)"
        );
        await clearTradeIngestCursor(userId);
    } else if (tradeFetch.nextBefore) {
        const nextBeforeSeconds = Number(tradeFetch.nextBefore);
        if (Number.isFinite(nextBeforeSeconds)) {
            await setTradeIngestCursor(userId, {
                afterSeconds: afterSeconds ?? 0,
                beforeSeconds: nextBeforeSeconds,
                maxSeenSeconds: sessionMaxSeenSeconds,
                updatedAt: new Date().toISOString(),
            });
        } else {
            log.warn(
                { nextBefore: tradeFetch.nextBefore },
                "Invalid nextBefore from trade pagination; clearing cursor"
            );
            await clearTradeIngestCursor(userId);
        }
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

        if (!proxyRecord.followedUser.enabled) {
            log.debug(
                { followedUserId: proxyRecord.followedUser.id },
                "Skipping fast trade ingest: followed user is disabled"
            );
            return { newCount: 0, latencyMs: Date.now() - fetchStart };
        }

        // Use the profile wallet for fetching
        return ingestTradesForWalletFast(proxyRecord.followedUser.profileWallet, options);
    }

    if (!followedUser.enabled) {
        log.debug(
            { followedUserId: followedUser.id },
            "Skipping fast trade ingest: followed user is disabled"
        );
        return { newCount: 0, latencyMs: Date.now() - fetchStart };
    }

    // Fetch ALL trades from API with pagination for fast reconcile
    // Uses smaller page size but still paginates to avoid missing trades
    const tradeFetch = await fetchAllWalletTrades(walletAddress, {
        after: Math.floor(afterTime.getTime() / 1000).toString(),
        maxPages: 5, // Smaller limit for fast reconcile: max 250 trades
        pageSize: 50,
    });
    const trades = tradeFetch.items;

    if (trades.length === 0) {
        log.debug("No new trades in fast fetch");
        return { newCount: 0, latencyMs: Date.now() - fetchStart };
    }

    log.debug(
        {
            count: trades.length,
            exhausted: tradeFetch.exhausted,
            hitMaxPages: tradeFetch.hitMaxPages,
            stalled: tradeFetch.stalled,
            pagesFetched: tradeFetch.pagesFetched,
        },
        "Fast fetched trades from API (paginated)"
    );

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
