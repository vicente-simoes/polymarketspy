/**
 * Copy attempt executor (Paper Trading).
 *
 * Orchestrates the full copy attempt flow:
 * 1. Apply timing delay (realism)
 * 2. Fetch order book
 * 3. Call shared decision engine
 * 4. Write CopyAttempt and ledger entries
 *
 * The decision logic is now in the shared decision engine, allowing
 * both paper and live executors to share the same decision path.
 */

import { TradeSide, PortfolioScope, CopyDecision, BookSource, TradingMode } from "@prisma/client";
import { ReasonCodes, type ReasonCode } from "@copybot/shared";
import { prisma } from "../db/prisma.js";
import { createLedgerEntryIfNotExistsAndUpdateCaches } from "../db/ledger.js";
import { createChildLogger } from "../log/logger.js";
import { env } from "../config/env.js";
import { CLOB_PRIORITY_EXECUTOR } from "../http/limiters.js";
import { getSystemConfig } from "../config/system.js";
import { getGlobalConfig, getUserConfig } from "./config.js";
import { getBook } from "./bookService.js";
import { normalizeOrderBook, type NormalizedBook } from "./bookUtils.js";
import type { TradeEventGroup, ActivityEventGroup, EventGroup, CopySourceType } from "./types.js";
import { fetchOrderBook } from "../poly/index.js";
import { makeDecision, type BookSnapshot, type CopyIntent } from "../trading/decisionEngine.js";
import { isReducingExposure, type PortfolioState } from "./guardrails.js";

const logger = createChildLogger({ module: "executor" });

const MARKET_ID_CACHE_TTL_MS = 60_000;
const marketIdCache = new Map<string, { marketId: string | null; expiresAtMs: number }>();

function isNumericMarketId(value: string | null): value is string {
    return typeof value === "string" && /^\d+$/.test(value);
}

function extractWindowStartMsFromGroupKey(groupKey: string): number | null {
    const match = groupKey.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    if (!match) return null;
    const parsed = Date.parse(match[0]);
    return Number.isNaN(parsed) ? null : parsed;
}

async function getMarketIdForToken(tokenId: string): Promise<string | null> {
    const now = Date.now();
    const cached = marketIdCache.get(tokenId);
    if (cached && cached.expiresAtMs > now) {
        return cached.marketId;
    }

    const meta = await prisma.tokenMetadataCache.findUnique({
        where: { tokenId },
        select: { marketId: true },
    });
    const marketId = meta?.marketId ?? null;
    marketIdCache.set(tokenId, { marketId, expiresAtMs: now + MARKET_ID_CACHE_TTL_MS });
    return marketId;
}

/**
 * Result of a copy attempt execution.
 */
export interface ExecutionResult {
    decision: CopyDecision;
    reasonCodes: ReasonCode[];
    copyAttemptId?: string;
    targetNotionalMicros: bigint;
    filledNotionalMicros: bigint;
    filledShareMicros: bigint;
    vwapPriceMicros: number;
    filledRatioBps: number;
}

/**
 * Sleep for timing realism.
 */
async function applyTimingDelay(decisionLatencyMs: number, jitterMsMax: number): Promise<void> {
    const jitter = Math.floor(Math.random() * jitterMsMax);
    const delay = decisionLatencyMs + jitter;
    await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Get current portfolio state for risk cap checks.
 */
async function getPortfolioState(
    scope: PortfolioScope,
    followedUserId: string | null
): Promise<PortfolioState> {
    // Get latest snapshot for equity
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
        where: {
            portfolioScope: scope,
            followedUserId: scope === PortfolioScope.EXEC_GLOBAL ? null : followedUserId,
        },
        orderBy: { bucketTime: "desc" },
    });

    const system = scope === PortfolioScope.EXEC_GLOBAL ? await getSystemConfig() : null;
    const defaultEquityMicros =
        scope === PortfolioScope.EXEC_GLOBAL && system
            ? BigInt(system.initialBankrollMicros)
            : BigInt(100_000_000_000); // Default 100k USDC
    const equityMicros = latestSnapshot?.equityMicros ?? defaultEquityMicros;
    const peakEquityMicros = equityMicros; // TODO: Track actual peak

    // Compute total exposure from positions
    const positions = await prisma.ledgerEntry.groupBy({
        by: ["assetId"],
        where: {
            tradingMode: TradingMode.PAPER,
            portfolioScope: scope,
            ...(scope === PortfolioScope.EXEC_GLOBAL ? {} : { followedUserId }),
            assetId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
        },
    });

    let totalExposureMicros = BigInt(0);
    const exposureByMarket = new Map<string, bigint>();

    const assetIds = [
        ...new Set(
            positions
                .map((p) => p.assetId)
                .filter((id): id is string => Boolean(id))
        ),
    ];
    const priceSnapshots = assetIds.length
        ? await prisma.currentPrice.findMany({
              where: { assetId: { in: assetIds } },
              select: { assetId: true, midpointPriceMicros: true },
          })
        : [];
    const priceByAsset = new Map<string, number>(
        priceSnapshots.map((snap) => [snap.assetId, snap.midpointPriceMicros])
    );

    const tokenMetadata = assetIds.length
        ? await prisma.tokenMetadataCache.findMany({
              where: { tokenId: { in: assetIds } },
              select: { tokenId: true, marketId: true },
          })
        : [];
    const marketIdByAsset = new Map<string, string | null>(
        tokenMetadata.map((meta) => [meta.tokenId, meta.marketId ?? null])
    );

    for (const pos of positions) {
        if (!pos.assetId || !pos._sum.shareDeltaMicros) continue;

        const priceMicros = priceByAsset.get(pos.assetId) ?? 500_000; // Default 0.50
        const positionValue =
            (pos._sum.shareDeltaMicros * BigInt(priceMicros)) / BigInt(1_000_000);

        // Use absolute value for exposure
        const absExposure = positionValue < BigInt(0) ? -positionValue : positionValue;
        totalExposureMicros += absExposure;

        const marketId = marketIdByAsset.get(pos.assetId) ?? null;
        if (marketId) {
            const current = exposureByMarket.get(marketId) ?? BigInt(0);
            exposureByMarket.set(marketId, current + absExposure);
        }
    }

    // Get per-user exposure (for global scope)
    const exposureByUser = new Map<string, bigint>();
    if (scope === PortfolioScope.EXEC_GLOBAL) {
        const perUserPositions = await prisma.ledgerEntry.groupBy({
            by: ["followedUserId", "assetId"],
            where: {
                tradingMode: TradingMode.PAPER,
                portfolioScope: scope,
                followedUserId: { not: null },
                assetId: { not: null },
            },
            _sum: {
                shareDeltaMicros: true,
            },
        });

        for (const pos of perUserPositions) {
            if (!pos.followedUserId || !pos.assetId || !pos._sum.shareDeltaMicros) continue;

            const priceMicros = priceByAsset.get(pos.assetId) ?? 500_000;
            const positionValue =
                (pos._sum.shareDeltaMicros * BigInt(priceMicros)) / BigInt(1_000_000);
            const absExposure = positionValue < BigInt(0) ? -positionValue : positionValue;

            const current = exposureByUser.get(pos.followedUserId) ?? BigInt(0);
            exposureByUser.set(pos.followedUserId, current + absExposure);
        }
    }

    // TODO: Compute actual daily/weekly PnL from ledger
    const dailyPnlMicros = BigInt(0);
    const weeklyPnlMicros = BigInt(0);

    return {
        equityMicros,
        totalExposureMicros,
        exposureByMarket,
        exposureByUser,
        dailyPnlMicros,
        weeklyPnlMicros,
        peakEquityMicros,
    };
}

/**
 * Options for copy attempt execution.
 */
export interface CopyAttemptOptions {
    sourceType?: CopySourceType;
    bufferedTradeCount?: number;
}

/**
 * Fetch order book with WS-first fallback to REST.
 * Handles crossed book detection and REST fallback.
 */
async function fetchBookWithFallback(
    tokenId: string,
    log: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<{ snapshot: BookSnapshot | null; fetchElapsedMs: number }> {
    const bookFetchStartedAtMs = Date.now();
    let bookResult = await getBook(tokenId, {
        waitMs: 500,
        freshnessMs: 2000,
    });
    let bookFetchElapsedMs = Date.now() - bookFetchStartedAtMs;
    let usedRestFallback = false;

    if (!bookResult.book) {
        log.warn("Order book not available (market may be resolved)");
        return { snapshot: null, fetchElapsedMs: bookFetchElapsedMs };
    }

    let book: NormalizedBook = bookResult.book;

    // Safety: WS cache can get into an invalid/crossed state (bestBid > bestAsk),
    // typically due to missing deltas during reconnects. Never simulate/execute
    // against a crossed book; instead, fall back to REST (source of truth).
    if (bookResult.source === "WS" && book.spreadMicros < 0) {
        const bookAgeMs = book.updatedAt > 0 ? Date.now() - book.updatedAt : null;
        log.warn(
            {
                bestBidMicros: book.bestBidMicros,
                bestAskMicros: book.bestAskMicros,
                spreadMicros: book.spreadMicros,
                bookAgeMs,
                bookStale: bookResult.stale,
            },
            "Crossed/invalid WS book detected; falling back to REST"
        );

        const restFetchStartedAtMs = Date.now();
        const rawRestBook = await fetchOrderBook(tokenId, { priority: CLOB_PRIORITY_EXECUTOR });
        const restFetchElapsedMs = Date.now() - restFetchStartedAtMs;
        bookFetchElapsedMs += restFetchElapsedMs;

        if (!rawRestBook) {
            log.warn(
                { restFetchElapsedMs },
                "REST order book unavailable after crossed WS book"
            );
            return { snapshot: null, fetchElapsedMs: bookFetchElapsedMs };
        }

        book = normalizeOrderBook(rawRestBook, "REST");
        if (book.spreadMicros < 0) {
            log.error(
                {
                    bestBidMicros: book.bestBidMicros,
                    bestAskMicros: book.bestAskMicros,
                    spreadMicros: book.spreadMicros,
                },
                "REST order book is crossed; refusing to simulate/execute"
            );
            return { snapshot: null, fetchElapsedMs: bookFetchElapsedMs };
        }
        bookResult = { book, source: "REST", stale: false };
        usedRestFallback = true;
    } else if (bookResult.source === "REST" && env.CLOB_BOOK_WS_ENABLED) {
        // WS enabled but we had to use REST (cache miss/placeholder).
        usedRestFallback = true;
    }

    const bookAgeMs = book.updatedAt > 0 ? Date.now() - book.updatedAt : 0;

    return {
        snapshot: {
            book,
            source: bookResult.source as "WS" | "REST",
            stale: bookResult.stale,
            ageMs: bookAgeMs,
            usedRestFallback,
        },
        fetchElapsedMs: bookFetchElapsedMs,
    };
}

/**
 * Convert CopyIntent decision to Prisma CopyDecision.
 */
function toPrismaCopyDecision(decision: "EXECUTE" | "SKIP"): CopyDecision {
    return decision === "EXECUTE" ? CopyDecision.EXECUTE : CopyDecision.SKIP;
}

/**
 * Execute a copy attempt for a trade event group.
 */
export async function executeTradeGroup(
    group: TradeEventGroup,
    portfolioScope: PortfolioScope,
    followedUserId: string | null,
    options: CopyAttemptOptions = {}
): Promise<ExecutionResult> {
    // Use rawTokenId (on-chain) if available, otherwise assetId (API)
    const effectiveTokenId = group.rawTokenId ?? group.assetId;
    let resolvedMarketId = isNumericMarketId(group.marketId) ? group.marketId : null;
    const windowStartMsFromGroupKey = extractWindowStartMsFromGroupKey(group.groupKey);

    const log = logger.child({
        groupKey: group.groupKey,
        scope: portfolioScope,
        followedUserId,
        side: group.side,
        tokenId: effectiveTokenId,
    });

    const sourceType = options.sourceType ?? "AGGREGATOR";
    const tradeCount = options.bufferedTradeCount ?? group.tradeEventIds.length;

    // Get config (paper trading mode)
    const config = followedUserId
        ? await getUserConfig(TradingMode.PAPER, followedUserId)
        : await getGlobalConfig(TradingMode.PAPER);
    const { guardrails, liveGuardrails, sizing } = config;

    // 1. Apply timing delay
    log.debug("Applying timing delay");
    await applyTimingDelay(guardrails.decisionLatencyMs, guardrails.jitterMsMax);

    // 2. Check for token ID
    if (!effectiveTokenId) {
        log.error("No token ID available for book simulation");
        return createSkipResult([ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS], BigInt(0));
    }

    // 3. Fetch order book
    log.debug("Fetching order book (cache-first)");
    const { snapshot: bookSnapshot, fetchElapsedMs } = await fetchBookWithFallback(effectiveTokenId, log);

    if (!bookSnapshot) {
        return createSkipResult([ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS], BigInt(0));
    }

    // 4. Get portfolio state
    const portfolioState = await getPortfolioState(portfolioScope, followedUserId);

    // 5. Resolve market ID if needed
    if (!resolvedMarketId && effectiveTokenId) {
        resolvedMarketId = await getMarketIdForToken(effectiveTokenId);
    }

    // 6. Call decision engine
    const reducingExposure = await isReducingExposure(
        TradingMode.PAPER,
        portfolioScope,
        followedUserId,
        effectiveTokenId,
        group.side
    );
    const intent = makeDecision({
        group,
        mode: TradingMode.PAPER,
        portfolioScope,
        sourceType,
        tradeCount,
        guardrails,
        liveGuardrails,
        sizing,
        portfolioState,
        bookSnapshot,
        resolvedMarketId,
        isReducingExposure: reducingExposure,
    });

    const decision = toPrismaCopyDecision(intent.decision);
    const lagSinceWindowStartMs =
        windowStartMsFromGroupKey !== null ? Date.now() - windowStartMsFromGroupKey : null;

    log.info(
        {
            decision: intent.decision,
            reasonCodes: intent.reasonCodes,
            targetNotional: intent.targetNotionalMicros.toString(),
            filledNotional: intent.simulation?.filledNotionalMicros.toString() ?? "0",
            filledRatio: intent.simulation?.filledRatioBps ?? 0,
            windowStartMs: windowStartMsFromGroupKey,
            lagSinceWindowStartMs,
            bookFetchElapsedMs: fetchElapsedMs,
            idempotencyKey: intent.idempotencyKey,
        },
        "Copy attempt decision"
    );

    // 7. Write CopyAttempt to database
    const copyAttemptData = {
        tradingMode: TradingMode.PAPER,
        portfolioScope,
        followedUserId,
        groupKey: group.groupKey,
        decision,
        reasonCodes: intent.reasonCodes,
        sourceType,
        bufferedTradeCount: tradeCount,
        bookSource: intent.bookSource === "WS" ? BookSource.WS : BookSource.REST,
        usedRestFallback: intent.usedRestFallback,
        spreadMicrosAtDecision: bookSnapshot.book.spreadMicros,
        targetNotionalMicros: intent.targetNotionalMicros,
        filledNotionalMicros: decision === CopyDecision.EXECUTE
            ? (intent.simulation?.filledNotionalMicros ?? BigInt(0))
            : BigInt(0),
        vwapPriceMicros: decision === CopyDecision.EXECUTE
            ? (intent.simulation?.vwapPriceMicros ?? null)
            : null,
        filledRatioBps: decision === CopyDecision.EXECUTE
            ? (intent.simulation?.filledRatioBps ?? 0)
            : 0,
        theirReferencePriceMicros: intent.theirReferencePriceMicros,
        midPriceMicrosAtDecision: intent.midPriceMicrosAtDecision,
    };

    let copyAttempt;
    if (followedUserId !== null) {
        // User scope: use compound unique key
        copyAttempt = await prisma.copyAttempt.upsert({
            where: {
                tradingMode_portfolioScope_followedUserId_groupKey: {
                    tradingMode: TradingMode.PAPER,
                    portfolioScope,
                    followedUserId,
                    groupKey: group.groupKey,
                },
            },
            create: copyAttemptData,
            update: {
                decision,
                reasonCodes: intent.reasonCodes,
                bookSource: intent.bookSource === "WS" ? BookSource.WS : BookSource.REST,
                usedRestFallback: intent.usedRestFallback,
                spreadMicrosAtDecision: bookSnapshot.book.spreadMicros,
                filledNotionalMicros: decision === CopyDecision.EXECUTE
                    ? (intent.simulation?.filledNotionalMicros ?? BigInt(0))
                    : BigInt(0),
                vwapPriceMicros: decision === CopyDecision.EXECUTE
                    ? (intent.simulation?.vwapPriceMicros ?? null)
                    : null,
                filledRatioBps: decision === CopyDecision.EXECUTE
                    ? (intent.simulation?.filledRatioBps ?? 0)
                    : 0,
            },
        });
    } else {
        // Global scope: use findFirst + upsert pattern for null followedUserId
        const existing = await prisma.copyAttempt.findFirst({
            where: {
                tradingMode: TradingMode.PAPER,
                portfolioScope,
                followedUserId: null,
                groupKey: group.groupKey,
            },
        });

        if (existing) {
            copyAttempt = await prisma.copyAttempt.update({
                where: { id: existing.id },
                data: {
                    decision,
                    reasonCodes: intent.reasonCodes,
                    bookSource: intent.bookSource === "WS" ? BookSource.WS : BookSource.REST,
                    usedRestFallback: intent.usedRestFallback,
                    spreadMicrosAtDecision: bookSnapshot.book.spreadMicros,
                    filledNotionalMicros: decision === CopyDecision.EXECUTE
                        ? (intent.simulation?.filledNotionalMicros ?? BigInt(0))
                        : BigInt(0),
                    vwapPriceMicros: decision === CopyDecision.EXECUTE
                        ? (intent.simulation?.vwapPriceMicros ?? null)
                        : null,
                    filledRatioBps: decision === CopyDecision.EXECUTE
                        ? (intent.simulation?.filledRatioBps ?? 0)
                        : 0,
                },
            });
        } else {
            copyAttempt = await prisma.copyAttempt.create({
                data: copyAttemptData,
            });
        }
    }

    // 8. Write ExecutableFill rows and ledger entries if EXECUTE
    if (decision === CopyDecision.EXECUTE && intent.simulation && intent.simulation.fills.length > 0) {
        // Write fill rows
        for (const fill of intent.simulation.fills) {
            await prisma.executableFill.create({
                data: {
                    copyAttemptId: copyAttempt.id,
                    filledShareMicros: fill.shareMicros,
                    fillPriceMicros: fill.priceMicros,
                    fillNotionalMicros: fill.notionalMicros,
                },
            });
        }

        // Write ledger entry
        const isBuy = group.side === TradeSide.BUY;
        const shareDeltaMicros = isBuy
            ? intent.simulation.filledShareMicros
            : -intent.simulation.filledShareMicros;
        const cashDeltaMicros = isBuy
            ? -intent.simulation.filledNotionalMicros
            : intent.simulation.filledNotionalMicros;

        const marketId = effectiveTokenId
            ? resolvedMarketId ?? (await getMarketIdForToken(effectiveTokenId))
            : resolvedMarketId;

        await prisma.$transaction(async (tx) => {
            await createLedgerEntryIfNotExistsAndUpdateCaches(tx, {
                portfolioScope,
                followedUserId,
                marketId,
                assetId: effectiveTokenId, // Use rawTokenId for WS-first trades
                entryType: "TRADE_FILL",
                shareDeltaMicros,
                cashDeltaMicros,
                priceMicros: intent.simulation!.vwapPriceMicros,
                refId: `copy:${copyAttempt.id}`,
            });
        });

        log.debug("Wrote ExecutableFill and LedgerEntry rows");
    }

    return {
        decision,
        reasonCodes: intent.reasonCodes,
        copyAttemptId: copyAttempt.id,
        targetNotionalMicros: intent.targetNotionalMicros,
        filledNotionalMicros: intent.simulation?.filledNotionalMicros ?? BigInt(0),
        filledShareMicros: intent.simulation?.filledShareMicros ?? BigInt(0),
        vwapPriceMicros: intent.simulation?.vwapPriceMicros ?? 0,
        filledRatioBps: intent.simulation?.filledRatioBps ?? 0,
    };
}

/**
 * Helper to create a SKIP result.
 */
function createSkipResult(reasonCodes: ReasonCode[], targetNotionalMicros: bigint): ExecutionResult {
    return {
        decision: CopyDecision.SKIP,
        reasonCodes,
        targetNotionalMicros,
        filledNotionalMicros: BigInt(0),
        filledShareMicros: BigInt(0),
        vwapPriceMicros: 0,
        filledRatioBps: 0,
    };
}

/**
 * Execute a copy attempt for an activity event group (MERGE/SPLIT).
 * TODO: Implement activity copy logic when applicable.
 */
export async function executeActivityGroup(
    group: ActivityEventGroup,
    portfolioScope: PortfolioScope,
    followedUserId: string | null
): Promise<ExecutionResult> {
    const log = logger.child({
        groupKey: group.groupKey,
        scope: portfolioScope,
        followedUserId,
        activityType: group.activityType,
    });

    // For now, skip MERGE/SPLIT copy attempts with reason code
    // In v0, we track them but don't execute
    log.info("Activity copy not applicable in v0");

    return {
        decision: CopyDecision.SKIP,
        reasonCodes: [ReasonCodes.MERGE_SPLIT_NOT_APPLICABLE],
        targetNotionalMicros: BigInt(0),
        filledNotionalMicros: BigInt(0),
        filledShareMicros: BigInt(0),
        vwapPriceMicros: 0,
        filledRatioBps: 0,
    };
}

/**
 * Execute a copy attempt for any event group.
 */
export async function executeCopyAttempt(
    group: EventGroup,
    portfolioScope: PortfolioScope,
    options: CopyAttemptOptions = {}
): Promise<ExecutionResult> {
    // Single global execution portfolio, but we still attribute every attempt
    // to the followed user that triggered it (for overrides + reporting).
    const followedUserId = group.followedUserId;

    if (group.type === "trade") {
        return executeTradeGroup(group, portfolioScope, followedUserId, options);
    } else {
        return executeActivityGroup(group, portfolioScope, followedUserId);
    }
}
