/**
 * Paper copy attempt executor.
 *
 * Orchestrates the paper trading copy attempt flow:
 * 1. Apply timing delay (paper-specific realism)
 * 2. Fetch config, portfolio state, order book
 * 3. Call shared decision engine
 * 4. Write CopyAttempt and ledger entries
 *
 * The actual decision logic (sizing, guardrails, simulation) is in the
 * shared decision engine at ../trading/decisionEngine.ts.
 */

import { TradeSide, PortfolioScope, CopyDecision, TradingMode } from "@prisma/client";
import { ReasonCodes, SizingMode, type ReasonCode } from "@copybot/shared";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { getSystemConfig } from "../config/system.js";
import { getGlobalConfig, getUserConfig } from "./config.js";
import { getBook } from "./bookService.js";
import { isReducingExposure, type PortfolioState } from "./guardrails.js";
import { computeCopyIntent, type DecisionEngineInput } from "../trading/decisionEngine.js";
import type { CopyIntent } from "../trading/types.js";
import type { TradeEventGroup, ActivityEventGroup, EventGroup, CopySourceType } from "./types.js";

const logger = createChildLogger({ module: "executor" });

const MARKET_ID_CACHE_TTL_MS = 60_000;
const marketIdCache = new Map<string, { marketId: string | null; expiresAtMs: number }>();

function isNumericMarketId(value: string | null): value is string {
    return typeof value === "string" && /^\d+$/.test(value);
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
    /** Idempotency key for this copy attempt (for observability). */
    idempotencyKey?: string;
}

/**
 * Sleep for timing realism (paper trading only).
 */
async function applyTimingDelay(decisionLatencyMs: number, jitterMsMax: number): Promise<void> {
    const jitter = Math.floor(Math.random() * jitterMsMax);
    const delay = decisionLatencyMs + jitter;
    await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Get current portfolio state for risk cap checks.
 * For paper trading, reads from paper snapshots and ledger.
 */
export async function getPortfolioState(
    scope: PortfolioScope,
    followedUserId: string | null,
    tradingMode: TradingMode = TradingMode.PAPER
): Promise<PortfolioState> {
    // Get latest snapshot for equity
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
        where: {
            tradingMode,
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
            tradingMode,
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
    const positionByAssetId = new Map<string, bigint>();

    const assetIds = [
        ...new Set(
            positions
                .map((p) => p.assetId)
                .filter((id): id is string => Boolean(id))
        ),
    ];
    const priceSnapshots = assetIds.length
        ? await prisma.marketPriceSnapshot.findMany({
              where: { assetId: { in: assetIds } },
              orderBy: { bucketTime: "desc" },
              distinct: ["assetId"],
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

        positionByAssetId.set(pos.assetId, pos._sum.shareDeltaMicros);

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
                tradingMode,
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
        positionByAssetId,
        dailyPnlMicros,
        weeklyPnlMicros,
        peakEquityMicros,
    };
}

/**
 * Get leader's exposure from latest SHADOW_USER snapshot.
 * Used for budgeted dynamic sizing to compute r_u = budget / leaderExposure.
 */
async function getLeaderExposureMicros(followedUserId: string): Promise<bigint> {
    const snapshot = await prisma.portfolioSnapshot.findFirst({
        where: {
            portfolioScope: PortfolioScope.SHADOW_USER,
            followedUserId,
        },
        orderBy: { bucketTime: "desc" },
        select: { exposureMicros: true },
    });

    if (!snapshot) {
        logger.warn(
            { followedUserId },
            "No SHADOW_USER snapshot found for leader exposure, using 0"
        );
        return BigInt(0);
    }

    return snapshot.exposureMicros;
}

/**
 * Options for copy attempt execution.
 */
export interface CopyAttemptOptions {
    sourceType?: CopySourceType;
    bufferedTradeCount?: number;
}

/**
 * Write CopyAttempt record to database.
 */
async function writeCopyAttempt(
    intent: CopyIntent,
    portfolioScope: PortfolioScope,
    tradingMode: TradingMode
): Promise<{ id: string }> {
    const copyAttemptData = {
        tradingMode,
        portfolioScope,
        followedUserId: intent.followedUserId || null,
        groupKey: intent.groupKey,
        decision: intent.decision === "EXECUTE" ? CopyDecision.EXECUTE : CopyDecision.SKIP,
        reasonCodes: intent.reasonCodes,
        sourceType: intent.sourceType,
        bufferedTradeCount: intent.bufferedTradeCount,
        targetNotionalMicros: intent.targetNotionalMicros,
        filledNotionalMicros: intent.decision === "EXECUTE" ? intent.simulation.filledNotionalMicros : BigInt(0),
        vwapPriceMicros: intent.decision === "EXECUTE" ? intent.simulation.vwapPriceMicros : null,
        filledRatioBps: intent.decision === "EXECUTE" ? intent.simulation.filledRatioBps : 0,
        theirReferencePriceMicros: intent.theirReferencePriceMicros,
        midPriceMicrosAtDecision: intent.midPriceMicrosAtDecision,
    };

    let copyAttempt;
    if (intent.followedUserId) {
        // User scope: use compound unique key
        copyAttempt = await prisma.copyAttempt.upsert({
            where: {
                tradingMode_portfolioScope_followedUserId_groupKey: {
                    tradingMode,
                    portfolioScope,
                    followedUserId: intent.followedUserId,
                    groupKey: intent.groupKey,
                },
            },
            create: copyAttemptData,
            update: {
                decision: copyAttemptData.decision,
                reasonCodes: copyAttemptData.reasonCodes,
                filledNotionalMicros: copyAttemptData.filledNotionalMicros,
                vwapPriceMicros: copyAttemptData.vwapPriceMicros,
                filledRatioBps: copyAttemptData.filledRatioBps,
            },
        });
    } else {
        // Global scope: use findFirst + upsert pattern for null followedUserId
        const existing = await prisma.copyAttempt.findFirst({
            where: {
                tradingMode,
                portfolioScope,
                followedUserId: null,
                groupKey: intent.groupKey,
            },
        });

        if (existing) {
            copyAttempt = await prisma.copyAttempt.update({
                where: { id: existing.id },
                data: {
                    decision: copyAttemptData.decision,
                    reasonCodes: copyAttemptData.reasonCodes,
                    filledNotionalMicros: copyAttemptData.filledNotionalMicros,
                    vwapPriceMicros: copyAttemptData.vwapPriceMicros,
                    filledRatioBps: copyAttemptData.filledRatioBps,
                },
            });
        } else {
            copyAttempt = await prisma.copyAttempt.create({
                data: copyAttemptData,
            });
        }
    }

    return { id: copyAttempt.id };
}

/**
 * Write ExecutableFill and LedgerEntry records for an executed copy attempt.
 */
async function writeFillsAndLedger(
    copyAttemptId: string,
    intent: CopyIntent,
    portfolioScope: PortfolioScope,
    tradingMode: TradingMode
): Promise<void> {
    const log = logger.child({ copyAttemptId, intent: intent.idempotencyKey });

    // Write fill rows
    for (const fill of intent.simulation.fills) {
        await prisma.executableFill.create({
            data: {
                copyAttemptId,
                filledShareMicros: fill.shareMicros,
                fillPriceMicros: fill.priceMicros,
                fillNotionalMicros: fill.notionalMicros,
            },
        });
    }

    // Resolve market ID if needed
    let resolvedMarketId = intent.marketId;
    if (!resolvedMarketId && intent.tokenId) {
        resolvedMarketId = await getMarketIdForToken(intent.tokenId);
    }

    // Write ledger entry
    const isBuy = intent.side === TradeSide.BUY;
    const shareDeltaMicros = isBuy
        ? intent.simulation.filledShareMicros
        : -intent.simulation.filledShareMicros;
    const cashDeltaMicros = isBuy
        ? -intent.simulation.filledNotionalMicros
        : intent.simulation.filledNotionalMicros;

    await prisma.ledgerEntry.upsert({
        where: {
            tradingMode_portfolioScope_refId_entryType: {
                tradingMode,
                portfolioScope,
                refId: `copy:${copyAttemptId}`,
                entryType: "TRADE_FILL",
            },
        },
        create: {
            tradingMode,
            portfolioScope,
            followedUserId: intent.followedUserId || null,
            marketId: resolvedMarketId,
            assetId: intent.tokenId || null,
            entryType: "TRADE_FILL",
            shareDeltaMicros,
            cashDeltaMicros,
            priceMicros: intent.simulation.vwapPriceMicros,
            refId: `copy:${copyAttemptId}`,
        },
        update: {},
    });

    log.debug("Wrote ExecutableFill and LedgerEntry rows");
}

/**
 * Execute a paper copy attempt for a trade event group.
 *
 * This function:
 * 1. Applies paper-specific timing delay
 * 2. Fetches necessary data (config, portfolio state, book)
 * 3. Calls the shared decision engine
 * 4. Persists the results (CopyAttempt, fills, ledger)
 */
export async function executeTradeGroup(
    group: TradeEventGroup,
    portfolioScope: PortfolioScope,
    followedUserId: string | null,
    options: CopyAttemptOptions = {}
): Promise<ExecutionResult> {
    const effectiveTokenId = group.rawTokenId ?? group.assetId;

    const log = logger.child({
        groupKey: group.groupKey,
        scope: portfolioScope,
        followedUserId,
        side: group.side,
        tokenId: effectiveTokenId,
    });

    // Get config (default to PAPER mode)
    const config = followedUserId
        ? await getUserConfig(followedUserId)
        : await getGlobalConfig();
    const { guardrails, sizing } = config;

    const sourceType = options.sourceType ?? "AGGREGATOR";

    // 1. Apply timing delay (paper-specific realism)
    log.debug("Applying timing delay");
    await applyTimingDelay(guardrails.decisionLatencyMs, guardrails.jitterMsMax);

    // 2. Check if we have a token ID (required for book fetch)
    if (!effectiveTokenId) {
        log.error("No token ID available for book simulation");
        return {
            decision: CopyDecision.SKIP,
            reasonCodes: [ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS],
            targetNotionalMicros: BigInt(0),
            filledNotionalMicros: BigInt(0),
            filledShareMicros: BigInt(0),
            vwapPriceMicros: 0,
            filledRatioBps: 0,
        };
    }

    // 3. Fetch order book
    log.debug("Fetching order book (cache-first)");
    const bookResult = await getBook(effectiveTokenId, {
        waitMs: 500,
        freshnessMs: 2000,
    });

    if (!bookResult.book) {
        log.warn("Order book not available (market may be resolved)");
        return {
            decision: CopyDecision.SKIP,
            reasonCodes: [ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS],
            targetNotionalMicros: BigInt(0),
            filledNotionalMicros: BigInt(0),
            filledShareMicros: BigInt(0),
            vwapPriceMicros: 0,
            filledRatioBps: 0,
        };
    }

    // 4. Get portfolio state
    const portfolioState = await getPortfolioState(portfolioScope, followedUserId, TradingMode.PAPER);

    // 5. Get leader exposure (for budgeted dynamic sizing)
    const useBudgetedDynamic =
        sizing.budgetedDynamicEnabled &&
        sizing.sizingMode === SizingMode.BUDGETED_DYNAMIC;

    let leaderExposureMicros: bigint | undefined;
    if (useBudgetedDynamic && followedUserId) {
        leaderExposureMicros = await getLeaderExposureMicros(followedUserId);
    }

    // 6. Resolve market ID
    let resolvedMarketId = isNumericMarketId(group.marketId) ? group.marketId : null;
    if (!resolvedMarketId && effectiveTokenId) {
        resolvedMarketId = await getMarketIdForToken(effectiveTokenId);
    }

    // 7. Call decision engine
    // Compute book age from the normalized book's updatedAt timestamp
    const bookAgeMs = bookResult.book.updatedAt > 0
        ? Date.now() - bookResult.book.updatedAt
        : undefined;

    const decisionInput: DecisionEngineInput = {
        group,
        portfolioState,
        guardrails,
        sizing,
        book: bookResult.book,
        bookMetadata: {
            source: bookResult.source ?? "REST", // Default to REST if null
            stale: bookResult.stale,
            ageMs: bookAgeMs,
        },
        sourceType,
        bufferedTradeCount: options.bufferedTradeCount,
        leaderExposureMicros,
        portfolioScope,
        marketId: resolvedMarketId,
    };

    const intent = computeCopyIntent(decisionInput);

    // 8. Write CopyAttempt
    const copyAttempt = await writeCopyAttempt(intent, portfolioScope, TradingMode.PAPER);

    // 9. Write fills and ledger if EXECUTE
    if (intent.decision === "EXECUTE" && intent.simulation.fills.length > 0) {
        await writeFillsAndLedger(copyAttempt.id, intent, portfolioScope, TradingMode.PAPER);
    }

    // 10. Return execution result
    return {
        decision: intent.decision === "EXECUTE" ? CopyDecision.EXECUTE : CopyDecision.SKIP,
        reasonCodes: intent.reasonCodes,
        copyAttemptId: copyAttempt.id,
        targetNotionalMicros: intent.targetNotionalMicros,
        filledNotionalMicros: intent.simulation.filledNotionalMicros,
        filledShareMicros: intent.simulation.filledShareMicros,
        vwapPriceMicros: intent.simulation.vwapPriceMicros,
        filledRatioBps: intent.simulation.filledRatioBps,
        idempotencyKey: intent.idempotencyKey,
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
