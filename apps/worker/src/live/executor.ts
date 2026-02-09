/**
 * Live Executor - Real Order Execution on Polymarket CLOB
 *
 * This module turns CopyIntents into real FAK orders on Polymarket's CLOB.
 * It builds on existing infrastructure (Steps 5-9) and integrates with:
 * - Decision Engine (shared with paper)
 * - Account State + Reservations (Step 6)
 * - Trading Params Cache (Step 5)
 * - CLOB Client (Step 7)
 * - User Channel WS (Step 8)
 * - Reconciliation (Step 9)
 *
 * Key design decisions:
 * 1. NO timing delay - execute immediately (unlike paper's 750ms + jitter)
 * 2. Stricter book freshness requirements (liveBookFreshnessMs)
 * 3. Tick/step rounding before submission (conservative: floor for BUY price, ceil for SELL)
 * 4. Shrink-to-fit for inventory constraints (reduce size rather than skip when possible)
 * 5. Reservation-based concurrency control (submit one order at a time per wallet)
 */

import { TradeSide, PortfolioScope, CopyDecision, BookSource, TradingMode, LiveOrderStatus } from "@prisma/client";
import { ReasonCodes, type ReasonCode } from "@copybot/shared";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { getSystemConfig } from "../config/system.js";
import { env } from "../config/env.js";
import { getUserConfig } from "../simulate/config.js";
import { getBook } from "../simulate/bookService.js";
import { normalizeOrderBook, type NormalizedBook } from "../simulate/bookUtils.js";
import type { TradeEventGroup, CopySourceType } from "../simulate/types.js";
import { fetchOrderBook } from "../poly/index.js";
import { CLOB_PRIORITY_EXECUTOR } from "../http/limiters.js";
import {
    makeDecision,
    isBookFreshEnoughForLive,
    computeLiveSlippageBounds,
    type BookSnapshot,
    type CopyIntent,
} from "../trading/decisionEngine.js";
import { isReducingExposure, type PortfolioState } from "../simulate/guardrails.js";
import {
    getTradingParams,
    type TradingParams,
    type TradingParamsResult,
} from "./tradingParams.js";
import {
    isStateHealthy,
    getAvailableCash,
    getAvailableShares,
    reserveCashForBuy,
    reserveSharesForSell,
    releaseReservation,
    acquireSubmissionLock,
    areSubmissionsPaused,
    getPauseReason,
    pauseSubmissions,
} from "./accountState.js";
import {
    placeOrderFAK,
    isLiveClientInitialized,
    type PlaceOrderResult,
} from "./clobClient.js";
import {
    hasReconciliationInitialized,
    isReconciliationHealthy,
} from "./reconciliation/index.js";
import {
    ceilToTick,
    checkPostTickRoundingMarketability,
    floorToStep,
    floorToTick,
    shrinkBuySharesToAffordable,
    shrinkSellSharesToAvailable,
} from "./orderMath.js";

const logger = createChildLogger({ module: "live-executor" });

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Result of live copy attempt execution.
 */
export interface LiveExecutionResult {
    decision: CopyDecision;
    reasonCodes: ReasonCode[];
    copyAttemptId?: string;
    liveOrderId?: string;
    clobOrderId?: string;
    targetNotionalMicros: bigint;
    filledShareMicros: bigint;
    filledNotionalMicros: bigint;
    error?: string;
}

/**
 * Options for live copy attempt execution.
 */
export interface LiveCopyAttemptOptions {
    sourceType?: CopySourceType;
    bufferedTradeCount?: number;
}

/**
 * Create a skip result with the given reason codes.
 */
function createSkipResult(
    reasonCodes: ReasonCode[],
    targetNotionalMicros: bigint,
    copyAttemptId?: string
): LiveExecutionResult {
    return {
        decision: CopyDecision.SKIP,
        reasonCodes,
        copyAttemptId,
        targetNotionalMicros,
        filledShareMicros: BigInt(0),
        filledNotionalMicros: BigInt(0),
    };
}

async function updateCopyAttemptToSkip(
    copyAttemptId: string,
    reasonCodes: ReasonCode[]
): Promise<void> {
    await prisma.copyAttempt.update({
        where: { id: copyAttemptId },
        data: {
            decision: CopyDecision.SKIP,
            reasonCodes,
        },
    });
}

async function createPersistedSkipResult(
    copyAttemptId: string,
    reasonCodes: ReasonCode[],
    targetNotionalMicros: bigint
): Promise<LiveExecutionResult> {
    await updateCopyAttemptToSkip(copyAttemptId, reasonCodes);
    return createSkipResult(reasonCodes, targetNotionalMicros, copyAttemptId);
}

/**
 * Get market ID from TokenMetadataCache.
 */
async function getMarketIdForToken(tokenId: string): Promise<string | null> {
    const meta = await prisma.tokenMetadataCache.findUnique({
        where: { tokenId },
        select: { marketId: true },
    });
    return meta?.marketId ?? null;
}

/**
 * Get portfolio state for risk checks (live mode).
 * Similar to paper executor but queries LIVE mode ledger entries.
 */
async function getPortfolioState(
    scope: PortfolioScope,
    followedUserId: string | null
): Promise<PortfolioState> {
    // Get latest snapshot for equity (use system config for initial bankroll)
    const system = await getSystemConfig();
    const defaultEquityMicros = BigInt(system.initialBankrollMicros);

    // For live, we use in-memory account state as the equity reference
    // since that's what we actually have available to trade with
    const availableCash = getAvailableCash();

    // Compute total exposure from positions (LIVE mode)
    const positions = await prisma.ledgerEntry.groupBy({
        by: ["assetId"],
        where: {
            tradingMode: TradingMode.LIVE,
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

        const priceMicros = priceByAsset.get(pos.assetId) ?? 500_000;
        const positionValue =
            (pos._sum.shareDeltaMicros * BigInt(priceMicros)) / BigInt(1_000_000);
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
                tradingMode: TradingMode.LIVE,
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

    // Use available cash as equity for live trading
    const equityMicros = availableCash > BigInt(0) ? availableCash : defaultEquityMicros;

    return {
        equityMicros,
        totalExposureMicros,
        exposureByMarket,
        exposureByUser,
        dailyPnlMicros: BigInt(0), // TODO: Compute from ledger
        weeklyPnlMicros: BigInt(0),
        peakEquityMicros: equityMicros,
    };
}

/**
 * Fetch order book with WS-first fallback to REST (stricter freshness for live).
 */
async function fetchBookWithFallback(
    tokenId: string,
    liveBookFreshnessMs: number,
    liveBookWaitMs: number,
    log: { warn: (obj: object | string, msg?: string) => void; error: (obj: object | string, msg?: string) => void }
): Promise<{ snapshot: BookSnapshot | null; fetchElapsedMs: number }> {
    const bookFetchStartedAtMs = Date.now();
    let bookResult = await getBook(tokenId, {
        waitMs: liveBookWaitMs,
        freshnessMs: liveBookFreshnessMs,
    });
    let bookFetchElapsedMs = Date.now() - bookFetchStartedAtMs;
    let usedRestFallback = false;

    if (!bookResult.book) {
        log.warn("Order book not available (market may be resolved)");
        return { snapshot: null, fetchElapsedMs: bookFetchElapsedMs };
    }

    let book: NormalizedBook = bookResult.book;

    const initialBookAgeMs = book.updatedAt > 0 ? Date.now() - book.updatedAt : 0;

    // If WS is stale for live execution, fall back to REST (source of truth).
    // This matches the spec's "wait briefly, then REST fallback" behavior.
    const shouldRestFallbackForStale =
        bookResult.source === "WS" &&
        (bookResult.stale || initialBookAgeMs > liveBookFreshnessMs);

    if (shouldRestFallbackForStale) {
        log.warn(
            {
                bestBidMicros: book.bestBidMicros,
                bestAskMicros: book.bestAskMicros,
                spreadMicros: book.spreadMicros,
                bookAgeMs: initialBookAgeMs,
                maxAgeMs: liveBookFreshnessMs,
            },
            "WS book stale for live execution; falling back to REST"
        );

        const restFetchStartedAtMs = Date.now();
        const rawRestBook = await fetchOrderBook(tokenId, { priority: CLOB_PRIORITY_EXECUTOR });
        const restFetchElapsedMs = Date.now() - restFetchStartedAtMs;
        bookFetchElapsedMs += restFetchElapsedMs;

        if (!rawRestBook) {
            log.warn("REST order book unavailable after stale WS book");
            return { snapshot: null, fetchElapsedMs: bookFetchElapsedMs };
        }

        book = normalizeOrderBook(rawRestBook, "REST");
        if (book.spreadMicros < 0) {
            log.error("REST order book is crossed; refusing to execute live order");
            return { snapshot: null, fetchElapsedMs: bookFetchElapsedMs };
        }
        bookResult = { book, source: "REST", stale: false };
        usedRestFallback = true;
    } else if (bookResult.source === "WS" && book.spreadMicros < 0) {
        const bookAgeMs = book.updatedAt > 0 ? Date.now() - book.updatedAt : null;
        log.warn(
            {
                bestBidMicros: book.bestBidMicros,
                bestAskMicros: book.bestAskMicros,
                spreadMicros: book.spreadMicros,
                bookAgeMs,
            },
            "Crossed WS book detected; falling back to REST"
        );

        const restFetchStartedAtMs = Date.now();
        const rawRestBook = await fetchOrderBook(tokenId, { priority: CLOB_PRIORITY_EXECUTOR });
        const restFetchElapsedMs = Date.now() - restFetchStartedAtMs;
        bookFetchElapsedMs += restFetchElapsedMs;

        if (!rawRestBook) {
            log.warn("REST order book unavailable after crossed WS book");
            return { snapshot: null, fetchElapsedMs: bookFetchElapsedMs };
        }

        book = normalizeOrderBook(rawRestBook, "REST");
        if (book.spreadMicros < 0) {
            log.error("REST order book is crossed; refusing to execute live order");
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

// ─── Main Execution Function ───────────────────────────────────────────────────

/**
 * Execute a live copy attempt for a trade event group.
 *
 * Flow:
 * 1. Pre-flight checks (system enablement, reconciliation health, submissions not paused)
 * 2. Fetch fresh book (stricter freshness: liveBookFreshnessMs)
 * 3. Load trading params (tick/min/step)
 * 4. Run decision engine -> CopyIntent
 * 5. Persist CopyAttempt (tradingMode=LIVE, always, even if SKIP)
 * 6. If EXECUTE:
 *    - Round order params (tick/step)
 *    - Post-rounding marketability check
 *    - Apply inventory constraints (shrink-to-affordable/available)
 *    - Reserve cash/shares
 *    - Create-or-get LiveOrder by idempotencyKey
 *    - Submit FAK order via CLOB client
 *    - Handle result (success -> OPEN; timeout -> SUBMISSION_UNKNOWN; error -> REJECTED)
 */
export async function executeLiveCopyAttempt(
    group: TradeEventGroup,
    options: LiveCopyAttemptOptions = {}
): Promise<LiveExecutionResult> {
    const effectiveTokenId = group.rawTokenId ?? group.assetId;
    const followedUserId = group.followedUserId;
    const portfolioScope = PortfolioScope.EXEC_GLOBAL;

    const log = logger.child({
        groupKey: group.groupKey,
        tokenId: effectiveTokenId,
        side: group.side,
        followedUserId,
    });

    const sourceType = options.sourceType ?? "AGGREGATOR";
    const tradeCount = options.bufferedTradeCount ?? group.tradeEventIds.length;

    // ─── Pre-flight Check 1: Client initialized ────────────────────────────────
    if (!isLiveClientInitialized()) {
        log.warn("CLOB client not initialized");
        return createSkipResult([ReasonCodes.LIVE_TRADING_DISABLED], BigInt(0));
    }

    // ─── Pre-flight Check 2: System enablement ─────────────────────────────────
    const systemConfig = await getSystemConfig();
    if (!systemConfig.liveTradingEnabled) {
        log.info("Live trading disabled globally");
        return createSkipResult([ReasonCodes.LIVE_TRADING_DISABLED], BigInt(0));
    }

    // ─── Pre-flight Check 3: Per-user enablement ───────────────────────────────
    const followedUser = await prisma.followedUser.findUnique({
        where: { id: followedUserId },
        select: { liveOverride: true, enabled: true },
    });

    if (!followedUser?.enabled) {
        log.info("User disabled");
        return createSkipResult([ReasonCodes.USER_DISABLED], BigInt(0));
    }

    if (followedUser.liveOverride === "FORCE_OFF") {
        log.info("User has liveOverride=FORCE_OFF");
        return createSkipResult([ReasonCodes.LIVE_USER_DISABLED], BigInt(0));
    }

    // ─── Pre-flight Check 4: Reconciliation health ─────────────────────────────
    if (!hasReconciliationInitialized()) {
        log.warn("Reconciliation has not initialized account state");
        return createSkipResult([ReasonCodes.LIVE_ACCOUNT_STATE_NOT_INITIALIZED], BigInt(0));
    }

    if (!isReconciliationHealthy()) {
        log.warn("Reconciliation is unhealthy");
        return createSkipResult([ReasonCodes.LIVE_RECONCILIATION_UNHEALTHY], BigInt(0));
    }

    // ─── Pre-flight Check 5: Submissions not paused ────────────────────────────
    if (areSubmissionsPaused()) {
        const reason = getPauseReason();
        log.warn({ reason }, "Live submissions paused");
        return createSkipResult([ReasonCodes.LIVE_SUBMISSIONS_PAUSED], BigInt(0));
    }

    // ─── Pre-flight Check 6: Account state healthy ─────────────────────────────
    if (!isStateHealthy()) {
        log.warn("Account state is stale or unhealthy");
        return createSkipResult([ReasonCodes.LIVE_ACCOUNT_STATE_UNHEALTHY], BigInt(0));
    }

    // ─── Pre-flight Check 7: Token ID available ────────────────────────────────
    if (!effectiveTokenId) {
        log.error("No token ID available");
        return createSkipResult([ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS], BigInt(0));
    }

    // ─── Load Config ───────────────────────────────────────────────────────────
    const config = await getUserConfig(TradingMode.LIVE, followedUserId);
    const { guardrails, liveGuardrails, sizing } = config;

    // ─── Fetch Order Book (NO timing delay - execute immediately) ──────────────
    log.debug("Fetching order book for live execution");
    const { snapshot: bookSnapshot, fetchElapsedMs } = await fetchBookWithFallback(
        effectiveTokenId,
        liveGuardrails.liveBookFreshnessMs,
        liveGuardrails.liveBookWaitMs,
        log
    );

    if (!bookSnapshot) {
        return createSkipResult([ReasonCodes.LIVE_NO_FRESH_BOOK], BigInt(0));
    }

    // Check book freshness for live execution
    if (!isBookFreshEnoughForLive(bookSnapshot.ageMs, liveGuardrails)) {
        log.warn({ bookAgeMs: bookSnapshot.ageMs, maxAgeMs: liveGuardrails.liveBookFreshnessMs },
            "Book too stale for live execution");
        return createSkipResult([ReasonCodes.LIVE_NO_FRESH_BOOK], BigInt(0));
    }

    // ─── Get Portfolio State ───────────────────────────────────────────────────
    const portfolioState = await getPortfolioState(portfolioScope, followedUserId);

    // ─── Resolve Market ID ─────────────────────────────────────────────────────
    const resolvedMarketId = await getMarketIdForToken(effectiveTokenId);

    // ─── Run Decision Engine ───────────────────────────────────────────────────
    const reducingExposure = await isReducingExposure(
        TradingMode.LIVE,
        portfolioScope,
        followedUserId,
        effectiveTokenId,
        group.side
    );

    const intent = makeDecision({
        group,
        mode: TradingMode.LIVE,
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
        currentPositionShareMicros: null,
    });

    log.info(
        {
            decision: intent.decision,
            reasonCodes: intent.reasonCodes,
            targetNotional: intent.targetNotionalMicros.toString(),
            targetShares: intent.targetShareMicros.toString(),
            idempotencyKey: intent.idempotencyKey,
            bookFetchElapsedMs: fetchElapsedMs,
        },
        "Live decision engine result"
    );

    // ─── Persist CopyAttempt (always, even if SKIP) ────────────────────────────
    const copyAttemptData = {
        tradingMode: TradingMode.LIVE,
        portfolioScope,
        followedUserId,
        groupKey: group.groupKey,
        decision: intent.decision === "EXECUTE" ? CopyDecision.EXECUTE : CopyDecision.SKIP,
        reasonCodes: intent.reasonCodes,
        sourceType,
        bufferedTradeCount: tradeCount,
        bookSource: intent.bookSource === "WS" ? BookSource.WS : BookSource.REST,
        usedRestFallback: intent.usedRestFallback,
        spreadMicrosAtDecision: bookSnapshot.book.spreadMicros,
        targetNotionalMicros: intent.targetNotionalMicros,
        filledNotionalMicros: BigInt(0), // Updated after fill
        vwapPriceMicros: null,
        filledRatioBps: 0,
        theirReferencePriceMicros: intent.theirReferencePriceMicros,
        midPriceMicrosAtDecision: intent.midPriceMicrosAtDecision,
    };

    // Use findFirst + upsert pattern for null followedUserId support
    const existingAttempt = await prisma.copyAttempt.findFirst({
        where: {
            tradingMode: TradingMode.LIVE,
            portfolioScope,
            followedUserId,
            groupKey: group.groupKey,
        },
    });

    let copyAttempt;
    if (existingAttempt) {
        copyAttempt = await prisma.copyAttempt.update({
            where: { id: existingAttempt.id },
            data: {
                decision: copyAttemptData.decision,
                reasonCodes: intent.reasonCodes,
                bookSource: copyAttemptData.bookSource,
                usedRestFallback: intent.usedRestFallback,
                spreadMicrosAtDecision: bookSnapshot.book.spreadMicros,
            },
        });
    } else {
        copyAttempt = await prisma.copyAttempt.create({
            data: copyAttemptData,
        });
    }

    // ─── If SKIP, return early ─────────────────────────────────────────────────
    if (intent.decision === "SKIP") {
        return createSkipResult(intent.reasonCodes, intent.targetNotionalMicros, copyAttempt.id);
    }

    // ─── Load Trading Params ───────────────────────────────────────────────────
    const paramsResult: TradingParamsResult = await getTradingParams(effectiveTokenId);
    if (!paramsResult.available) {
        log.warn({ reason: paramsResult.reason }, "Trading params unavailable");
        return createPersistedSkipResult(
            copyAttempt.id,
            [ReasonCodes.LIVE_INVALID_TICK_OR_STEP],
            intent.targetNotionalMicros
        );
    }
    const tradingParams: TradingParams = paramsResult.params;

    // ─── Extract Price Bounds and Book State ───────────────────────────────────
    const { bestBidMicros, bestAskMicros } = bookSnapshot.book;
    const isBuy = group.side === TradeSide.BUY;

    // Compute live slippage bounds
    const slippageBounds = computeLiveSlippageBounds(
        group.side,
        bestBidMicros,
        bestAskMicros,
        liveGuardrails
    );

    // Get the effective limit price from CopyIntent
    let limitPriceMicros: number;
    if (isBuy) {
        // For BUY: use maxBuyPriceMicros from intent, or slippage bounds
        limitPriceMicros = Math.min(
            intent.maxBuyPriceMicros ?? slippageBounds.maxPriceMicros ?? bestAskMicros,
            slippageBounds.maxPriceMicros ?? intent.maxBuyPriceMicros ?? bestAskMicros
        );
    } else {
        // For SELL: use minSellPriceMicros from intent, or slippage bounds
        limitPriceMicros = Math.max(
            intent.minSellPriceMicros ?? slippageBounds.minPriceMicros ?? bestBidMicros,
            slippageBounds.minPriceMicros ?? intent.minSellPriceMicros ?? bestBidMicros
        );
    }

    // ─── Round Price to Tick ───────────────────────────────────────────────────
    const roundedPriceMicros = isBuy
        ? floorToTick(limitPriceMicros, tradingParams.tickSizeMicros)
        : ceilToTick(limitPriceMicros, tradingParams.tickSizeMicros);

    const marketability = checkPostTickRoundingMarketability({
        side: group.side,
        roundedPriceMicros,
        bestBidMicros,
        bestAskMicros,
    });
    if (!marketability.ok) {
        log.warn(
            {
                side: group.side,
                roundedPrice: roundedPriceMicros,
                bestBid: bestBidMicros,
                bestAsk: bestAskMicros,
                originalPrice: limitPriceMicros,
            },
            "Price not marketable after tick rounding"
        );
        return createPersistedSkipResult(copyAttempt.id, [marketability.reasonCode], intent.targetNotionalMicros);
    }

    // ─── Round Size to Step ────────────────────────────────────────────────────
    let targetShareMicros = floorToStep(intent.targetShareMicros, tradingParams.sizeStepShareMicros);

    // Check against minimum order size
    if (targetShareMicros < tradingParams.minOrderSizeShareMicros) {
        log.warn(
            {
                targetShares: intent.targetShareMicros.toString(),
                roundedShares: targetShareMicros.toString(),
                minOrderSize: tradingParams.minOrderSizeShareMicros.toString(),
            },
            "Rounded size below exchange minimum"
        );
        return createPersistedSkipResult(
            copyAttempt.id,
            [ReasonCodes.LIVE_BELOW_MIN_ORDER_SIZE],
            intent.targetNotionalMicros
        );
    }

    // ─── Apply Inventory Constraints (shrink-to-fit) ───────────────────────────
    if (isBuy) {
        const availableCash = getAvailableCash();
        const shrink = shrinkBuySharesToAffordable({
            targetShareMicros,
            priceMicros: roundedPriceMicros,
            availableCashMicros: availableCash,
            sizeStepShareMicros: tradingParams.sizeStepShareMicros,
            minOrderSizeShareMicros: tradingParams.minOrderSizeShareMicros,
        });

        if (!shrink.ok) {
            log.warn(
                { availableCash: availableCash.toString(), priceMicros: roundedPriceMicros, requestedShares: targetShareMicros.toString() },
                "Insufficient cash to BUY even minimum size"
            );
            return createPersistedSkipResult(copyAttempt.id, [shrink.reasonCode], intent.targetNotionalMicros);
        }

        if (shrink.wasShrunk) {
            log.info(
                {
                    originalShares: targetShareMicros.toString(),
                    shrunkShares: shrink.shareMicros.toString(),
                    availableCash: availableCash.toString(),
                },
                "Shrunk BUY order to affordable size"
            );
            targetShareMicros = shrink.shareMicros;
        }
    } else {
        const availableShares = getAvailableShares(effectiveTokenId);
        const shrink = shrinkSellSharesToAvailable({
            targetShareMicros,
            availableShareMicros: availableShares,
            sizeStepShareMicros: tradingParams.sizeStepShareMicros,
            minOrderSizeShareMicros: tradingParams.minOrderSizeShareMicros,
        });

        if (!shrink.ok) {
            log.warn(
                {
                    requestedShares: targetShareMicros.toString(),
                    availableShares: availableShares.toString(),
                },
                "Insufficient position to SELL even minimum size"
            );
            return createPersistedSkipResult(copyAttempt.id, [shrink.reasonCode], intent.targetNotionalMicros);
        }

        if (shrink.wasShrunk) {
            log.info(
                {
                    originalShares: targetShareMicros.toString(),
                    shrunkShares: shrink.shareMicros.toString(),
                    availableShares: availableShares.toString(),
                },
                "Shrunk SELL order to available position"
            );
            targetShareMicros = shrink.shareMicros;
        }
    }

    // ─── Reserve Cash/Shares ───────────────────────────────────────────────────
    const idempotencyKey = intent.idempotencyKey;
    let reservationResult;

    if (isBuy) {
        reservationResult = reserveCashForBuy(
            effectiveTokenId,
            roundedPriceMicros,
            targetShareMicros,
            idempotencyKey
        );
    } else {
        reservationResult = reserveSharesForSell(
            effectiveTokenId,
            targetShareMicros,
            idempotencyKey
        );
    }

    if (!reservationResult.success) {
        log.warn({ reason: reservationResult.reason }, "Failed to reserve for order");
        const reasonCode = isBuy
            ? ReasonCodes.LIVE_INSUFFICIENT_CASH_TO_BUY
            : ReasonCodes.LIVE_INSUFFICIENT_POSITION_TO_SELL;
        return createPersistedSkipResult(copyAttempt.id, [reasonCode], intent.targetNotionalMicros);
    }

    // ─── Create or Get LiveOrder ───────────────────────────────────────────────
    // Check for existing order by idempotencyKey BEFORE submission (idempotent)
    const existingOrder = await prisma.liveOrder.findUnique({
        where: { idempotencyKey },
    });

    if (existingOrder) {
        // Already submitted - don't resubmit, release reservation
        log.info({ liveOrderId: existingOrder.id }, "Order already exists by idempotencyKey");
        releaseReservation(idempotencyKey);

        return {
            decision: CopyDecision.EXECUTE,
            reasonCodes: [],
            copyAttemptId: copyAttempt.id,
            liveOrderId: existingOrder.id,
            clobOrderId: existingOrder.clobOrderId ?? undefined,
            targetNotionalMicros: intent.targetNotionalMicros,
            filledShareMicros: existingOrder.filledShareMicros,
            filledNotionalMicros: existingOrder.filledNotionalMicros,
        };
    }

    // Create LiveOrder row BEFORE network call (persist intent)
    const liveOrder = await prisma.liveOrder.create({
        data: {
            idempotencyKey,
            copyAttemptId: copyAttempt.id,
            followedUserId,
            tokenId: effectiveTokenId,
            side: group.side,
            orderType: liveGuardrails.liveOrderType,
            limitPriceMicros: roundedPriceMicros,
            sizeShareMicros: targetShareMicros,
            bestBidMicrosAtDecision: bestBidMicros,
            bestAskMicrosAtDecision: bestAskMicros,
            bookSource: intent.bookSource === "WS" ? BookSource.WS : BookSource.REST,
            bookAgeMs: bookSnapshot.ageMs,
            status: LiveOrderStatus.CREATED,
        },
    });

    log.info({ liveOrderId: liveOrder.id }, "Created LiveOrder row");

    // ─── Acquire Submission Lock ───────────────────────────────────────────────
    const releaseLock = await acquireSubmissionLock();

    try {
        // Update to SUBMITTING
        await prisma.liveOrder.update({
            where: { id: liveOrder.id },
            data: { status: LiveOrderStatus.SUBMITTING, submittedAt: new Date() },
        });

        // ─── Submit FAK Order ──────────────────────────────────────────────────
        log.info(
            {
                tokenId: effectiveTokenId,
                side: group.side,
                priceMicros: roundedPriceMicros,
                sizeShareMicros: targetShareMicros.toString(),
            },
            "Submitting FAK order"
        );

        const result: PlaceOrderResult = await placeOrderFAK({
            tokenId: effectiveTokenId,
            side: group.side,
            priceMicros: roundedPriceMicros,
            sizeShareMicros: targetShareMicros,
        });

        if (result.success) {
            // Update order with clobOrderId and OPEN status
            await prisma.liveOrder.update({
                where: { id: liveOrder.id },
                data: {
                    clobOrderId: result.clobOrderId,
                    status: LiveOrderStatus.OPEN,
                    lastUpdateAt: new Date(),
                },
            });

            log.info(
                { liveOrderId: liveOrder.id, clobOrderId: result.clobOrderId, status: result.status },
                "FAK order submitted successfully"
            );

            // For FAK orders, fills come via User Channel WS and reconciliation
            // We don't have fill info immediately, but the order is in-flight
            return {
                decision: CopyDecision.EXECUTE,
                reasonCodes: [],
                copyAttemptId: copyAttempt.id,
                liveOrderId: liveOrder.id,
                clobOrderId: result.clobOrderId,
                targetNotionalMicros: intent.targetNotionalMicros,
                filledShareMicros: BigInt(0), // Fills populated by WS/reconciliation
                filledNotionalMicros: BigInt(0),
            };
        } else {
            // Handle error
            const errorCode = result.error.code;
            const errorMessage = result.error.message;
            const isRetryable = result.error.isRetryable;

            const status = isRetryable
                ? LiveOrderStatus.SUBMISSION_UNKNOWN
                : LiveOrderStatus.REJECTED;

            await prisma.liveOrder.update({
                where: { id: liveOrder.id },
                data: {
                    status,
                    lastErrorCode: errorCode,
                    lastErrorMessage: errorMessage,
                    lastUpdateAt: new Date(),
                    finalizedAt: status === LiveOrderStatus.REJECTED ? new Date() : null,
                },
            });

            log.error(
                { liveOrderId: liveOrder.id, errorCode, errorMessage, isRetryable },
                "FAK order submission failed"
            );

            // Release reservation on failure
            releaseReservation(idempotencyKey);

            // Pause submissions on SUBMISSION_UNKNOWN
            if (status === LiveOrderStatus.SUBMISSION_UNKNOWN) {
                pauseSubmissions(`SUBMISSION_UNKNOWN for order ${liveOrder.id}: ${errorCode}`);
            }

            // Map error code to reason code
            let reasonCode: ReasonCode = ReasonCodes.LIVE_ORDER_REJECTED_UNKNOWN;
            if (errorCode.includes("MIN_SIZE")) {
                reasonCode = ReasonCodes.LIVE_ORDER_REJECTED_MIN_SIZE;
            } else if (errorCode.includes("TICK_SIZE")) {
                reasonCode = ReasonCodes.LIVE_ORDER_REJECTED_TICK_SIZE;
            } else if (errorCode.includes("INSUFFICIENT_BALANCE")) {
                reasonCode = ReasonCodes.LIVE_ORDER_REJECTED_INSUFFICIENT_BALANCE;
            } else if (errorCode.includes("AUTH")) {
                reasonCode = ReasonCodes.LIVE_ORDER_REJECTED_AUTH;
            } else if (isRetryable) {
                reasonCode = ReasonCodes.LIVE_SUBMISSION_TIMEOUT;
            }

            await updateCopyAttemptToSkip(copyAttempt.id, [reasonCode]);

            return {
                decision: CopyDecision.SKIP,
                reasonCodes: [reasonCode],
                copyAttemptId: copyAttempt.id,
                liveOrderId: liveOrder.id,
                targetNotionalMicros: intent.targetNotionalMicros,
                filledShareMicros: BigInt(0),
                filledNotionalMicros: BigInt(0),
                error: errorMessage,
            };
        }
    } finally {
        releaseLock();
    }
}
