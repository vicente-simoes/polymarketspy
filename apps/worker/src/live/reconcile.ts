/**
 * Live reconciliation loops (Step 9).
 *
 * Safety net for missed WS events and the source of truth for the Real Portfolio:
 * - Reconcile open orders (heal missed status transitions, resolve SUBMISSION_UNKNOWN)
 * - Reconcile cash + positions (authoritative snapshot; drives RealPositionSnapshot + LIVE PortfolioSnapshot)
 * - Persist ledger-vs-exchange diffs (diagnostic signal)
 *
 * This module is read-only with respect to the exchange (no order placement).
 */

import {
    LedgerEntryType,
    LiveFillOrigin,
    LiveOrderStatus,
    PortfolioScope,
    TradeSide,
    TradingMode,
} from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    applyFill,
    adjustReservationForFill,
    pauseSubmissions,
    reconcile as reconcileAccountState,
    releaseReservation,
} from "./accountState.js";
import {
    getBalance,
    getOrder,
    getTrades,
    getWalletAddress,
    isLiveClientConfigured,
    listOpenOrders,
    type ClobOrderInfo,
    type ClobOrderStatus,
    type ClobTrade,
} from "./clobClient.js";
import { fetchWalletPositions, sharesToMicros } from "../poly/client.js";
import { getLatestPrices } from "../snapshot/prices.js";
import { getCheckpoint, setCheckpoint } from "../ingest/checkpoint.js";

const logger = createChildLogger({ module: "live-reconcile" });

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const MINUTE_MS = 60_000;

const OPEN_ORDERS_RECONCILE_INTERVAL_MS = 45_000; // 30–60s per spec
const POSITIONS_RECONCILE_INTERVAL_MS = 60_000; // 60s per spec

const TRADE_LOOKBACK_MS = 2 * 60_000; // overlap to avoid missing trades on cursor edges
const INITIAL_TRADE_LOOKBACK_MS = 10 * 60_000;

const SUBMISSION_UNKNOWN_MATCH_WINDOW_MS = 10 * 60_000;
const SUBMISSION_UNKNOWN_MAX_AGE_MS = 10 * 60_000;

// For FAK orders, if the exchange can no longer return the order, assume it finalized.
const FAK_ORDER_NOT_FOUND_FINALIZE_AFTER_MS = 60_000;

// -----------------------------------------------------------------------------
// Status helpers
// -----------------------------------------------------------------------------

const STATUS_PRECEDENCE: Record<LiveOrderStatus, number> = {
    [LiveOrderStatus.CREATED]: 0,
    [LiveOrderStatus.SUBMITTING]: 1,
    [LiveOrderStatus.SUBMISSION_UNKNOWN]: 2,
    [LiveOrderStatus.OPEN]: 3,
    [LiveOrderStatus.PARTIAL]: 4,
    [LiveOrderStatus.CANCELED]: 5,
    [LiveOrderStatus.FILLED]: 6,
    [LiveOrderStatus.REJECTED]: 7,
    [LiveOrderStatus.FAILED]: 8,
};

function isFinalStatus(status: LiveOrderStatus): boolean {
    return (
        status === LiveOrderStatus.FILLED ||
        status === LiveOrderStatus.CANCELED ||
        status === LiveOrderStatus.REJECTED ||
        status === LiveOrderStatus.FAILED
    );
}

function chooseMonotonicStatus(current: LiveOrderStatus, next: LiveOrderStatus): LiveOrderStatus {
    const cur = STATUS_PRECEDENCE[current] ?? 0;
    const nxt = STATUS_PRECEDENCE[next] ?? 0;
    return nxt >= cur ? next : current;
}

function clobStatusToLiveStatus(status: ClobOrderStatus): LiveOrderStatus {
    switch (status) {
        case "LIVE":
            return LiveOrderStatus.OPEN;
        case "MATCHED":
            return LiveOrderStatus.PARTIAL;
        case "FILLED":
            return LiveOrderStatus.FILLED;
        case "CANCELED":
        case "EXPIRED":
            return LiveOrderStatus.CANCELED;
        default:
            return LiveOrderStatus.OPEN;
    }
}

function getMinuteBucketTime(timestamp: Date): Date {
    const ms = timestamp.getTime();
    const bucketMs = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
    return new Date(bucketMs);
}

// -----------------------------------------------------------------------------
// Checkpoints
// -----------------------------------------------------------------------------

const BASELINE_TIME_KEY = "live:baselineTime";
const BASELINE_EQUITY_KEY = "live:baselineEquityMicros";
const BASELINE_POSITIONS_KEY = "live:baselinePositions";
const LAST_POSITIONS_RECONCILE_KEY = "live:lastPositionsReconcile";
const LEDGER_DIFFS_KEY = "live:ledgerDiffs";

type BaselineTimeCheckpoint = { timestamp: string };
type BaselineEquityCheckpoint = { equityMicros: string };
type BaselinePositionsCheckpoint = { positions: Record<string, string> };

type LedgerDiffCheckpoint = {
    updatedAt: string;
    tokenCount: number;
    diffs: Array<{
        tokenId: string;
        exchangeShareMicros: string;
        ledgerShareMicros: string;
        deltaMicros: string;
    }>;
};

// -----------------------------------------------------------------------------
// Metrics / status
// -----------------------------------------------------------------------------

interface LiveReconcileStatus {
    running: boolean;
    openOrders: {
        lastRunAt: string | null;
        lastSuccessAt: string | null;
        lastError: string | null;
        inFlight: boolean;
        processedOrders: number;
        resolvedSubmissionUnknown: number;
        createdFillsFromTrades: number;
    };
    positions: {
        lastRunAt: string | null;
        lastSuccessAt: string | null;
        lastError: string | null;
        inFlight: boolean;
        tokenCount: number;
        cashAvailableMicros: string | null;
        equityMicros: string | null;
        baselineEquityMicros: string | null;
    };
}

const status: LiveReconcileStatus = {
    running: false,
    openOrders: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        inFlight: false,
        processedOrders: 0,
        resolvedSubmissionUnknown: 0,
        createdFillsFromTrades: 0,
    },
    positions: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        inFlight: false,
        tokenCount: 0,
        cashAvailableMicros: null,
        equityMicros: null,
        baselineEquityMicros: null,
    },
};

export function getLiveReconcileStatus(): LiveReconcileStatus {
    return JSON.parse(JSON.stringify(status)) as LiveReconcileStatus;
}

// -----------------------------------------------------------------------------
// Trade reconciliation (heal missed fills)
// -----------------------------------------------------------------------------

let lastTradesCursorAt: Date | null = null;

function computeNotionalMicros(shareMicros: bigint, priceMicros: number): bigint {
    return (shareMicros * BigInt(priceMicros)) / BigInt(1_000_000);
}

async function upsertFillFromTrade(trade: ClobTrade): Promise<{ created: boolean; liveOrderId: string | null }> {
    const tradeId = trade.tradeId;
    const tokenId = trade.tokenId;
    const side = trade.side === "BUY" ? TradeSide.BUY : TradeSide.SELL;
    const shareMicros = trade.shareMicros;
    const priceMicros = trade.priceMicros;
    const matchedAt = trade.matchedAt;
    const notionalMicros = computeNotionalMicros(shareMicros, priceMicros);

    const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.liveFill.findUnique({
            where: { tradeId },
            select: { id: true },
        });
        if (existing) return { created: false, liveOrderId: null as string | null };

        const liveOrder = await tx.liveOrder.findUnique({
            where: { clobOrderId: trade.orderId },
            select: {
                id: true,
                followedUserId: true,
                sizeShareMicros: true,
                filledShareMicros: true,
                filledNotionalMicros: true,
                status: true,
            },
        });

        const origin = liveOrder ? LiveFillOrigin.APP : LiveFillOrigin.EXTERNAL;

        await tx.liveFill.create({
            data: {
                tradeId,
                clobOrderId: trade.orderId,
                tokenId,
                side,
                priceMicros,
                shareMicros,
                notionalMicros,
                feeMicros: null,
                origin,
                matchedAt,
                status: "MATCHED",
                liveOrderId: liveOrder?.id ?? null,
            },
        });

        const tokenMeta = await tx.tokenMetadataCache.findUnique({
            where: { tokenId },
            select: { marketId: true },
        });

        const shareDeltaMicros = side === TradeSide.BUY ? shareMicros : -shareMicros;
        const cashDeltaMicros = side === TradeSide.BUY ? -notionalMicros : notionalMicros;

        await tx.ledgerEntry.upsert({
            where: {
                tradingMode_portfolioScope_refId_entryType: {
                    tradingMode: TradingMode.LIVE,
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                    refId: tradeId,
                    entryType: LedgerEntryType.TRADE_FILL,
                },
            },
            create: {
                tradingMode: TradingMode.LIVE,
                portfolioScope: PortfolioScope.EXEC_GLOBAL,
                followedUserId: liveOrder?.followedUserId ?? null,
                marketId: tokenMeta?.marketId ?? null,
                assetId: tokenId,
                entryType: LedgerEntryType.TRADE_FILL,
                shareDeltaMicros,
                cashDeltaMicros,
                priceMicros,
                refId: tradeId,
            },
            update: {
                // If the fill was previously attributed as external and we later
                // link the LiveOrder (SUBMISSION_UNKNOWN resolution), a separate
                // re-attribution pass will fix followedUserId.
            },
        });

        if (liveOrder) {
            const newFilledShareMicros = liveOrder.filledShareMicros + shareMicros;
            const newFilledNotionalMicros = liveOrder.filledNotionalMicros + notionalMicros;
            const avgFillPriceMicros =
                newFilledShareMicros > BigInt(0)
                    ? Number((newFilledNotionalMicros * BigInt(1_000_000)) / newFilledShareMicros)
                    : null;

            const fillImpliedStatus =
                newFilledShareMicros >= liveOrder.sizeShareMicros
                    ? LiveOrderStatus.FILLED
                    : LiveOrderStatus.PARTIAL;

            const nextStatus = isFinalStatus(liveOrder.status)
                ? liveOrder.status
                : chooseMonotonicStatus(liveOrder.status, fillImpliedStatus);

            await tx.liveOrder.update({
                where: { id: liveOrder.id },
                data: {
                    filledShareMicros: newFilledShareMicros,
                    filledNotionalMicros: newFilledNotionalMicros,
                    avgFillPriceMicros: avgFillPriceMicros ?? undefined,
                    status: nextStatus,
                    lastUpdateAt: matchedAt,
                    ...(nextStatus === LiveOrderStatus.FILLED ? { finalizedAt: matchedAt } : {}),
                },
            });

            if (isFinalStatus(nextStatus)) {
                releaseReservation(liveOrder.id);
            }
        }

        return { created: true, liveOrderId: liveOrder?.id ?? null };
    });

    // Best-effort in-memory update (fees unknown; apply gross notional).
    if (result.created && result.liveOrderId) {
        adjustReservationForFill(result.liveOrderId, notionalMicros, shareMicros);
    }
    applyFill(side, tokenId, shareMicros, notionalMicros);

    return result;
}

async function reconcileRecentTrades(): Promise<number> {
    const now = new Date();
    const after = lastTradesCursorAt
        ? new Date(lastTradesCursorAt.getTime() - TRADE_LOOKBACK_MS)
        : new Date(now.getTime() - INITIAL_TRADE_LOOKBACK_MS);

    const trades = await getTrades({ after });

    let created = 0;
    let maxMatchedAt = lastTradesCursorAt;

    for (const trade of trades) {
        const result = await upsertFillFromTrade(trade);
        if (result.created) {
            created++;
        }
        if (!maxMatchedAt || trade.matchedAt > maxMatchedAt) {
            maxMatchedAt = trade.matchedAt;
        }
    }

    // Move cursor forward even if there were no trades, to avoid re-fetching
    // large windows on a quiet wallet.
    lastTradesCursorAt = maxMatchedAt ?? now;
    return created;
}

// -----------------------------------------------------------------------------
// SUBMISSION_UNKNOWN resolution
// -----------------------------------------------------------------------------

async function reattributeFillsAndLedgerForOrder(args: {
    clobOrderId: string;
    liveOrderId: string;
    followedUserId: string | null;
}): Promise<void> {
    // Link any existing fills that were inserted before we knew the order ID.
    await prisma.liveFill.updateMany({
        where: {
            clobOrderId: args.clobOrderId,
            liveOrderId: null,
        },
        data: {
            liveOrderId: args.liveOrderId,
            origin: LiveFillOrigin.APP,
        },
    });

    // Re-attribute ledger entries for those fills (idempotent upsert key is tradeId).
    if (args.followedUserId) {
        const fills = await prisma.liveFill.findMany({
            where: { clobOrderId: args.clobOrderId },
            select: { tradeId: true },
        });
        const tradeIds = fills.map((f) => f.tradeId);
        if (tradeIds.length) {
            await prisma.ledgerEntry.updateMany({
                where: {
                    tradingMode: TradingMode.LIVE,
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                    entryType: LedgerEntryType.TRADE_FILL,
                    refId: { in: tradeIds },
                },
                data: { followedUserId: args.followedUserId },
            });
        }
    }

    // Refresh LiveOrder aggregates from fills we now consider linked.
    const fills = await prisma.liveFill.findMany({
        where: { liveOrderId: args.liveOrderId },
        select: { shareMicros: true, notionalMicros: true, matchedAt: true },
        orderBy: { matchedAt: "asc" },
    });
    const filledShareMicros = fills.reduce((acc, f) => acc + f.shareMicros, 0n);
    const filledNotionalMicros = fills.reduce((acc, f) => acc + f.notionalMicros, 0n);
    const avgFillPriceMicros =
        filledShareMicros > 0n
            ? Number((filledNotionalMicros * 1_000_000n) / filledShareMicros)
            : null;
    const lastMatchedAt = fills.length ? fills[fills.length - 1]!.matchedAt : null;

    await prisma.liveOrder.update({
        where: { id: args.liveOrderId },
        data: {
            filledShareMicros,
            filledNotionalMicros,
            avgFillPriceMicros: avgFillPriceMicros ?? undefined,
            ...(lastMatchedAt ? { lastUpdateAt: lastMatchedAt } : {}),
        },
    });
}

function isGtcLikeOrderType(orderType: unknown): boolean {
    // Prisma enum is LiveOrderType (FAK/FOK/GTC). Avoid importing enum from schema here.
    return String(orderType).toUpperCase() === "GTC";
}

async function tryResolveSubmissionUnknownOrder(
    order: {
        id: string;
        tokenId: string;
        side: TradeSide;
        limitPriceMicros: number;
        sizeShareMicros: bigint;
        createdAt: Date;
        followedUserId: string | null;
    },
    openOrders: ClobOrderInfo[],
    trades: ClobTrade[]
): Promise<{ resolved: boolean }> {
    const now = new Date();
    const ageMs = now.getTime() - order.createdAt.getTime();

    const candidates = openOrders.filter((o) => {
        if (o.tokenId !== order.tokenId) return false;
        if ((o.side === "BUY" ? TradeSide.BUY : TradeSide.SELL) !== order.side) return false;
        if (o.priceMicros !== order.limitPriceMicros) return false;
        if (o.originalSizeShareMicros !== order.sizeShareMicros) return false;
        return Math.abs(o.createdAt.getTime() - order.createdAt.getTime()) <= SUBMISSION_UNKNOWN_MATCH_WINDOW_MS;
    });

    if (candidates.length > 1) {
        pauseSubmissions(
            `SUBMISSION_UNKNOWN match ambiguous (${candidates.length} candidates) for liveOrderId=${order.id}`
        );
        logger.error(
            { liveOrderId: order.id, candidateCount: candidates.length },
            "SUBMISSION_UNKNOWN match ambiguous"
        );
        return { resolved: false };
    }

    const chosenFromOpenOrder = candidates[0] ?? null;
    const matchingTrades = trades.filter((t) => {
        if (t.tokenId !== order.tokenId) return false;
        if ((t.side === "BUY" ? TradeSide.BUY : TradeSide.SELL) !== order.side) return false;
        // Require trade after order creation minus small overlap.
        return t.matchedAt.getTime() >= order.createdAt.getTime() - TRADE_LOOKBACK_MS;
    });

    const uniqueTradeOrderIds = [
        ...new Set(matchingTrades.map((t) => t.orderId).filter(Boolean)),
    ];

    const chosenClobOrderId =
        chosenFromOpenOrder?.orderId ??
        (uniqueTradeOrderIds.length === 1 ? uniqueTradeOrderIds[0]! : null);

    if (!chosenClobOrderId) {
        if (ageMs >= SUBMISSION_UNKNOWN_MAX_AGE_MS) {
            await prisma.liveOrder.update({
                where: { id: order.id },
                data: {
                    status: LiveOrderStatus.FAILED,
                    lastUpdateAt: now,
                    finalizedAt: now,
                    lastErrorCode: "SUBMISSION_UNKNOWN_UNRESOLVED",
                    lastErrorMessage:
                        "Could not match to an open order or recent trades within the bounded window",
                },
            });

            pauseSubmissions(`SUBMISSION_UNKNOWN unresolved > ${SUBMISSION_UNKNOWN_MAX_AGE_MS}ms`);
            logger.error({ liveOrderId: order.id }, "SUBMISSION_UNKNOWN unresolved; marked FAILED");
        }
        return { resolved: false };
    }

    const exchangeStatus = chosenFromOpenOrder
        ? clobStatusToLiveStatus(chosenFromOpenOrder.status)
        : LiveOrderStatus.PARTIAL;

    await prisma.liveOrder.update({
        where: { id: order.id },
        data: {
            clobOrderId: chosenClobOrderId,
            status: chooseMonotonicStatus(LiveOrderStatus.SUBMISSION_UNKNOWN, exchangeStatus),
            submittedAt: now,
            lastUpdateAt: now,
        },
    });

    await reattributeFillsAndLedgerForOrder({
        clobOrderId: chosenClobOrderId,
        liveOrderId: order.id,
        followedUserId: order.followedUserId,
    });

    logger.info({ liveOrderId: order.id, clobOrderId: chosenClobOrderId }, "Resolved SUBMISSION_UNKNOWN");
    return { resolved: true };
}

// -----------------------------------------------------------------------------
// Open orders reconciliation loop
// -----------------------------------------------------------------------------

async function reconcileOpenOrdersOnce(): Promise<void> {
    if (!isLiveClientConfigured()) {
        return;
    }
    if (status.openOrders.inFlight) return;

    status.openOrders.inFlight = true;
    status.openOrders.lastRunAt = new Date().toISOString();
    status.openOrders.lastError = null;

    const runLog = logger.child({ loop: "open-orders" });

    try {
        const createdFillsFromTrades = await reconcileRecentTrades();
        status.openOrders.createdFillsFromTrades = createdFillsFromTrades;

        const nonFinalOrders = await prisma.liveOrder.findMany({
            where: {
                status: {
                    notIn: [
                        LiveOrderStatus.FILLED,
                        LiveOrderStatus.CANCELED,
                        LiveOrderStatus.REJECTED,
                        LiveOrderStatus.FAILED,
                    ],
                },
            },
            orderBy: { createdAt: "asc" },
            select: {
                id: true,
                clobOrderId: true,
                status: true,
                tokenId: true,
                side: true,
                limitPriceMicros: true,
                sizeShareMicros: true,
                filledShareMicros: true,
                orderType: true,
                createdAt: true,
                submittedAt: true,
                finalizedAt: true,
                followedUserId: true,
            },
        });

        status.openOrders.processedOrders = nonFinalOrders.length;

        const submissionUnknown = nonFinalOrders.filter(
            (o) => o.status === LiveOrderStatus.SUBMISSION_UNKNOWN && !o.clobOrderId
        );

        const openOrders = submissionUnknown.length ? await listOpenOrders() : [];

        const minUnknownCreatedAt = submissionUnknown.length
            ? submissionUnknown.reduce(
                  (min, o) => (o.createdAt < min ? o.createdAt : min),
                  submissionUnknown[0]!.createdAt
              )
            : null;

        const tradesForUnknown = submissionUnknown.length
            ? await getTrades({
                  after: new Date((minUnknownCreatedAt ?? new Date()).getTime() - TRADE_LOOKBACK_MS),
              })
            : [];

        // 1) Resolve SUBMISSION_UNKNOWN orders missing clobOrderId.
        let resolvedCount = 0;
        for (const order of submissionUnknown) {
            const { resolved } = await tryResolveSubmissionUnknownOrder(
                {
                    id: order.id,
                    tokenId: order.tokenId,
                    side: order.side,
                    limitPriceMicros: order.limitPriceMicros,
                    sizeShareMicros: order.sizeShareMicros,
                    createdAt: order.createdAt,
                    followedUserId: order.followedUserId ?? null,
                },
                openOrders,
                tradesForUnknown
            );
            if (resolved) resolvedCount++;
        }
        status.openOrders.resolvedSubmissionUnknown = resolvedCount;

        // 2) Refresh exchange status for orders with known clobOrderId.
        for (const order of nonFinalOrders) {
            if (!order.clobOrderId) continue;

            const now = new Date();

            let info: ClobOrderInfo | null = null;
            try {
                info = await getOrder(order.clobOrderId);
            } catch (err) {
                runLog.warn({ err, clobOrderId: order.clobOrderId }, "getOrder failed");
                continue;
            }

            if (!info) {
                // For GTC-like orders, "not found" is ambiguous; do not auto-finalize.
                if (isGtcLikeOrderType(order.orderType)) {
                    continue;
                }

                const ageMs = now.getTime() - order.createdAt.getTime();
                if (ageMs < FAK_ORDER_NOT_FOUND_FINALIZE_AFTER_MS) {
                    continue;
                }

                const finalStatus =
                    order.filledShareMicros >= order.sizeShareMicros
                        ? LiveOrderStatus.FILLED
                        : LiveOrderStatus.CANCELED;

                const nextStatus = chooseMonotonicStatus(order.status, finalStatus);

                await prisma.liveOrder.update({
                    where: { id: order.id },
                    data: {
                        status: nextStatus,
                        lastUpdateAt: now,
                        ...(isFinalStatus(nextStatus) && !order.finalizedAt ? { finalizedAt: now } : {}),
                    },
                });

                if (isFinalStatus(nextStatus)) {
                    releaseReservation(order.id);
                }

                continue;
            }

            const mappedStatus = clobStatusToLiveStatus(info.status);
            const nextStatus = chooseMonotonicStatus(order.status, mappedStatus);

            const shouldSetSubmittedAt =
                order.submittedAt === null &&
                (nextStatus === LiveOrderStatus.OPEN ||
                    nextStatus === LiveOrderStatus.PARTIAL ||
                    nextStatus === LiveOrderStatus.CANCELED ||
                    nextStatus === LiveOrderStatus.FILLED);

            const shouldSetFinalizedAt = order.finalizedAt === null && isFinalStatus(nextStatus);

            await prisma.liveOrder.update({
                where: { id: order.id },
                data: {
                    status: nextStatus,
                    filledShareMicros:
                        info.filledSizeShareMicros > order.filledShareMicros
                            ? info.filledSizeShareMicros
                            : order.filledShareMicros,
                    lastUpdateAt: now,
                    ...(shouldSetSubmittedAt ? { submittedAt: now } : {}),
                    ...(shouldSetFinalizedAt ? { finalizedAt: now } : {}),
                },
            });

            if (isFinalStatus(nextStatus)) {
                releaseReservation(order.id);
            }
        }

        status.openOrders.lastSuccessAt = new Date().toISOString();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status.openOrders.lastError = msg;
        runLog.error({ err }, "Open orders reconciliation failed");
    } finally {
        status.openOrders.inFlight = false;
    }
}

// -----------------------------------------------------------------------------
// Cash + positions reconciliation loop
// -----------------------------------------------------------------------------

async function fetchAuthoritativePositions(): Promise<Map<string, bigint>> {
    const walletAddress = getWalletAddress();
    if (!walletAddress) {
        throw new Error("Live wallet address unavailable");
    }

    // For MVP we use Data API positions.
    // If the official client supports a bulk positions call in the future, prefer it.
    const positions = await fetchWalletPositions(walletAddress, { limit: 2000 });

    const map = new Map<string, bigint>();
    for (const pos of positions) {
        const tokenId =
            pos.assetId ?? pos.asset_id ?? pos.tokenId ?? pos.token_id ?? null;
        const sizeRaw = pos.size ?? pos.shares ?? pos.quantity ?? null;
        if (!tokenId || sizeRaw == null) continue;
        const shareMicros = sharesToMicros(sizeRaw);
        if (shareMicros === 0n) continue;
        map.set(tokenId, shareMicros);
    }
    return map;
}

async function ensureBaseline(args: {
    bucketTime: Date;
    equityMicros: bigint;
    positions: Map<string, bigint>;
}): Promise<{
    baselineEquityMicros: bigint;
}> {
    const baselineTime = await getCheckpoint<BaselineTimeCheckpoint>(BASELINE_TIME_KEY);
    const baselineEquity = await getCheckpoint<BaselineEquityCheckpoint>(BASELINE_EQUITY_KEY);

    if (baselineTime && baselineEquity) {
        return { baselineEquityMicros: BigInt(baselineEquity.equityMicros) };
    }

    const positionsJson: Record<string, string> = {};
    for (const [tokenId, shareMicros] of args.positions.entries()) {
        positionsJson[tokenId] = shareMicros.toString();
    }

    await Promise.all([
        setCheckpoint<BaselineTimeCheckpoint>(BASELINE_TIME_KEY, {
            timestamp: args.bucketTime.toISOString(),
        }),
        setCheckpoint<BaselineEquityCheckpoint>(BASELINE_EQUITY_KEY, {
            equityMicros: args.equityMicros.toString(),
        }),
        setCheckpoint<BaselinePositionsCheckpoint>(BASELINE_POSITIONS_KEY, {
            positions: positionsJson,
        }),
    ]);

    logger.info(
        { bucketTime: args.bucketTime.toISOString(), equityMicros: args.equityMicros.toString() },
        "Initialized live portfolio baseline"
    );

    return { baselineEquityMicros: args.equityMicros };
}

async function computeAndPersistLedgerDiffs(exchangePositions: Map<string, bigint>): Promise<void> {
    const grouped = await prisma.ledgerEntry.groupBy({
        by: ["assetId"],
        where: {
            tradingMode: TradingMode.LIVE,
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            assetId: { not: null },
        },
        _sum: { shareDeltaMicros: true },
    });

    const ledgerPositions = new Map<string, bigint>();
    for (const row of grouped) {
        const tokenId = row.assetId;
        if (!tokenId) continue;
        const shareMicros = row._sum.shareDeltaMicros ?? 0n;
        if (shareMicros !== 0n) {
            ledgerPositions.set(tokenId, shareMicros);
        }
    }

    const allTokenIds = new Set<string>([
        ...exchangePositions.keys(),
        ...ledgerPositions.keys(),
    ]);

    const diffs: LedgerDiffCheckpoint["diffs"] = [];
    for (const tokenId of allTokenIds) {
        const ex = exchangePositions.get(tokenId) ?? 0n;
        const led = ledgerPositions.get(tokenId) ?? 0n;
        const delta = ex - led;
        if (delta === 0n) continue;
        diffs.push({
            tokenId,
            exchangeShareMicros: ex.toString(),
            ledgerShareMicros: led.toString(),
            deltaMicros: delta.toString(),
        });
    }

    diffs.sort((a, b) => {
        const absA = BigInt(a.deltaMicros);
        const absB = BigInt(b.deltaMicros);
        const magA = absA < 0n ? -absA : absA;
        const magB = absB < 0n ? -absB : absB;
        return magB > magA ? 1 : magB < magA ? -1 : 0;
    });

    const checkpoint: LedgerDiffCheckpoint = {
        updatedAt: new Date().toISOString(),
        tokenCount: diffs.length,
        diffs: diffs.slice(0, 50),
    };
    await setCheckpoint<LedgerDiffCheckpoint>(LEDGER_DIFFS_KEY, checkpoint);
}

async function reconcileCashAndPositionsOnce(): Promise<void> {
    if (!isLiveClientConfigured()) {
        return;
    }
    if (status.positions.inFlight) return;

    status.positions.inFlight = true;
    status.positions.lastRunAt = new Date().toISOString();
    status.positions.lastError = null;

    const runLog = logger.child({ loop: "positions" });

    try {
        const bucketTime = getMinuteBucketTime(new Date());

        const balance = await getBalance();
        const cashAvailableMicros = balance.cashAvailableMicros;

        const positions = await fetchAuthoritativePositions();
        const tokenIds = [...positions.keys()];

        // Persist authoritative position snapshot
        await prisma.$transaction(async (tx) => {
            for (const [tokenId, shareMicros] of positions.entries()) {
                await tx.realPositionSnapshot.upsert({
                    where: {
                        tokenId_bucketTime: {
                            tokenId,
                            bucketTime,
                        },
                    },
                    create: {
                        tokenId,
                        bucketTime,
                        shareMicros,
                        source: "RECONCILE",
                    },
                    update: {
                        shareMicros,
                        source: "RECONCILE",
                    },
                });
            }
        });

        // Compute portfolio snapshot values
        const prices = tokenIds.length ? await getLatestPrices(tokenIds) : new Map<string, number>();

        let totalPositionValueMicros = 0n;
        let totalExposureMicros = 0n;
        for (const [tokenId, shareMicros] of positions.entries()) {
            const priceMicros = prices.get(tokenId) ?? 500_000; // default 0.50 if no price
            const valueMicros = (shareMicros * BigInt(priceMicros)) / 1_000_000n;
            totalPositionValueMicros += valueMicros;
            const absValue = valueMicros < 0n ? -valueMicros : valueMicros;
            totalExposureMicros += absValue;
        }

        const equityMicros = cashAvailableMicros + totalPositionValueMicros;
        const { baselineEquityMicros } = await ensureBaseline({
            bucketTime,
            equityMicros,
            positions,
        });

        // For MVP, treat all PnL since baseline as "unrealized".
        const pnlSinceBaselineMicros = equityMicros - baselineEquityMicros;

        // Write LIVE portfolio snapshot (null followedUserId; handle duplicates safely).
        const result = await prisma.portfolioSnapshot.updateMany({
            where: {
                tradingMode: TradingMode.LIVE,
                portfolioScope: PortfolioScope.EXEC_GLOBAL,
                followedUserId: null,
                bucketTime,
            },
            data: {
                equityMicros,
                cashMicros: cashAvailableMicros,
                exposureMicros: totalExposureMicros,
                unrealizedPnlMicros: pnlSinceBaselineMicros,
                realizedPnlMicros: 0n,
            },
        });

        if (result.count === 0) {
            await prisma.portfolioSnapshot.create({
                data: {
                    tradingMode: TradingMode.LIVE,
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                    followedUserId: null,
                    bucketTime,
                    equityMicros,
                    cashMicros: cashAvailableMicros,
                    exposureMicros: totalExposureMicros,
                    unrealizedPnlMicros: pnlSinceBaselineMicros,
                    realizedPnlMicros: 0n,
                },
            });
        }

        // Update in-memory state from authoritative snapshot.
        reconcileAccountState(cashAvailableMicros, positions);

        // Persist diagnostic diffs (ledger vs exchange).
        await computeAndPersistLedgerDiffs(positions);

        await setCheckpoint(LAST_POSITIONS_RECONCILE_KEY, { timestamp: new Date().toISOString() });

        status.positions.tokenCount = positions.size;
        status.positions.cashAvailableMicros = cashAvailableMicros.toString();
        status.positions.equityMicros = equityMicros.toString();
        status.positions.baselineEquityMicros = baselineEquityMicros.toString();
        status.positions.lastSuccessAt = new Date().toISOString();

        runLog.info(
            {
                bucketTime: bucketTime.toISOString(),
                tokenCount: positions.size,
                cashAvailableMicros: cashAvailableMicros.toString(),
                equityMicros: equityMicros.toString(),
            },
            "Live positions reconciliation complete"
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status.positions.lastError = msg;
        runLog.error({ err }, "Positions reconciliation failed");
    } finally {
        status.positions.inFlight = false;
    }
}

// -----------------------------------------------------------------------------
// Public start/stop
// -----------------------------------------------------------------------------

let openOrdersTimer: NodeJS.Timeout | null = null;
let positionsTimer: NodeJS.Timeout | null = null;

export function startLiveReconciliationLoops(): void {
    if (openOrdersTimer || positionsTimer) {
        logger.warn("Live reconciliation loops already running");
        return;
    }

    if (!isLiveClientConfigured()) {
        logger.info("Live reconciliation not started (POLYMARKET_LIVE_PRIVATE_KEY not set)");
        return;
    }

    status.running = true;
    logger.info(
        {
            openOrdersIntervalMs: OPEN_ORDERS_RECONCILE_INTERVAL_MS,
            positionsIntervalMs: POSITIONS_RECONCILE_INTERVAL_MS,
        },
        "Starting live reconciliation loops"
    );

    // Run immediately, then on interval.
    void reconcileOpenOrdersOnce();
    void reconcileCashAndPositionsOnce();

    openOrdersTimer = setInterval(() => {
        void reconcileOpenOrdersOnce();
    }, OPEN_ORDERS_RECONCILE_INTERVAL_MS);

    positionsTimer = setInterval(() => {
        void reconcileCashAndPositionsOnce();
    }, POSITIONS_RECONCILE_INTERVAL_MS);
}

export function stopLiveReconciliationLoops(): void {
    status.running = false;

    if (openOrdersTimer) {
        clearInterval(openOrdersTimer);
        openOrdersTimer = null;
    }
    if (positionsTimer) {
        clearInterval(positionsTimer);
        positionsTimer = null;
    }

    logger.info("Live reconciliation loops stopped");
}
