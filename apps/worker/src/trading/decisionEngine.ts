/**
 * Shared decision engine for copy trading.
 *
 * This module extracts the "decision" logic from execution, allowing
 * both paper and live executors to use the same strategy/decision path.
 *
 * The decision engine:
 * - Computes sizing (raw + clamps + budget enforcement)
 * - Computes price bounds
 * - Simulates fills against the book
 * - Runs guardrail checks
 * - Outputs a CopyIntent with the decision
 *
 * The decision engine does NOT:
 * - Apply timing delays (executor responsibility)
 * - Write to database (executor responsibility)
 * - Know about TradingMode (mode-agnostic)
 */

import { createHash } from "crypto";
import { TradeSide, PortfolioScope } from "@prisma/client";
import {
    ReasonCodes,
    SizingMode,
    BudgetEnforcement,
    type ReasonCode,
    type Guardrails,
    type Sizing,
} from "@copybot/shared";
import { createChildLogger } from "../log/logger.js";
import type { TradeEventGroup, CopySourceType } from "../simulate/types.js";
import type { NormalizedBook } from "../simulate/bookUtils.js";
import { simulateFromNormalizedBook, type SimulationResult } from "../simulate/book.js";
import {
    computeRawTargetNotional,
    applyTradeSizingClamps,
    computeTargetShares,
} from "../simulate/sizing.js";
import {
    checkSpreadFilter,
    checkMaxBuyCostPerShare,
    checkDepthRequirement,
    computePriceBounds,
    checkPriceProtection,
    checkCircuitBreakers,
    checkExposureCaps,
    isReducingExposure,
    type PortfolioState,
} from "../simulate/guardrails.js";
import type { CopyIntent, BookSnapshot, SizingMetadata, CopyDecisionType } from "./types.js";

const logger = createChildLogger({ module: "decision-engine" });

/**
 * Input to the decision engine.
 */
export interface DecisionEngineInput {
    /** Trade event group to process. */
    group: TradeEventGroup;
    /** Portfolio state for risk checks. */
    portfolioState: PortfolioState;
    /** Guardrails configuration. */
    guardrails: Guardrails;
    /** Sizing configuration. */
    sizing: Sizing;
    /** Normalized order book. */
    book: NormalizedBook;
    /** Book metadata (source, freshness). */
    bookMetadata: {
        source: "WS" | "REST";
        stale: boolean;
        ageMs?: number;
    };
    /** Source type of this copy attempt. */
    sourceType: CopySourceType;
    /** Number of buffered trades (for BUFFER source). */
    bufferedTradeCount?: number;
    /** Leader exposure for budgeted dynamic sizing. */
    leaderExposureMicros?: bigint;
    /** Portfolio scope for guardrail checks. */
    portfolioScope: PortfolioScope;
    /** Resolved market ID (if available). */
    marketId: string | null;
}

/**
 * Result when book is not available.
 */
export interface NoBookResult {
    type: "no_book";
    tokenId: string | null;
    groupKey: string;
    followedUserId: string;
    reasonCodes: ReasonCode[];
}

/**
 * Generate a deterministic idempotency key for a copy intent.
 *
 * Format: v1_<sha256-hash-prefix>
 *
 * The key is derived from the stable inputs that define "same intended copy trade":
 * - followedUserId
 * - tokenId
 * - side
 * - groupKey
 *
 * This ensures the same trade group always produces the same key,
 * enabling safe retries and duplicate detection.
 */
export function generateIdempotencyKey(
    followedUserId: string,
    tokenId: string,
    side: TradeSide,
    groupKey: string
): string {
    const payload = `${followedUserId}:${tokenId}:${side}:${groupKey}`;
    const hash = createHash("sha256").update(payload).digest("hex").slice(0, 32);
    return `v1_${hash}`;
}

/**
 * Create an empty simulation result for early-skip cases.
 */
function createEmptySimulation(book: NormalizedBook, targetShareMicros: bigint): SimulationResult {
    return {
        success: false,
        error: "Early skip - no simulation performed",
        bestBidMicros: book.bestBidMicros,
        bestAskMicros: book.bestAskMicros,
        midPriceMicros: book.midPriceMicros,
        spreadMicros: book.spreadMicros,
        availableNotionalMicros: BigInt(0),
        targetShareMicros,
        filledShareMicros: BigInt(0),
        filledNotionalMicros: BigInt(0),
        vwapPriceMicros: 0,
        filledRatioBps: 0,
        fills: [],
    };
}

/**
 * Create a book snapshot from normalized book and metadata.
 */
function createBookSnapshot(
    book: NormalizedBook,
    metadata: { source: "WS" | "REST"; stale: boolean; ageMs?: number }
): BookSnapshot {
    return {
        bestBidMicros: book.bestBidMicros,
        bestAskMicros: book.bestAskMicros,
        midPriceMicros: book.midPriceMicros,
        spreadMicros: book.spreadMicros,
        source: metadata.source,
        stale: metadata.stale,
        ageMs: metadata.ageMs,
    };
}

/**
 * Compute a CopyIntent for a trade event group.
 *
 * This is the core decision engine function. It takes all inputs needed
 * to make a copy decision and returns a CopyIntent with the outcome.
 *
 * The function is pure in the sense that it doesn't write to the database
 * or have side effects beyond logging. Executors are responsible for
 * persistence based on the returned intent.
 */
export function computeCopyIntent(input: DecisionEngineInput): CopyIntent {
    const {
        group,
        portfolioState,
        guardrails,
        sizing,
        book,
        bookMetadata,
        sourceType,
        bufferedTradeCount,
        leaderExposureMicros,
        portfolioScope,
        marketId,
    } = input;

    // Use rawTokenId (on-chain) if available, otherwise assetId (API)
    const effectiveTokenId = group.rawTokenId ?? group.assetId;

    const log = logger.child({
        groupKey: group.groupKey,
        followedUserId: group.followedUserId,
        side: group.side,
        tokenId: effectiveTokenId,
    });

    const reasonCodes: ReasonCode[] = [];
    const isBufferSource = sourceType === "BUFFER";

    // Generate idempotency key
    const idempotencyKey = effectiveTokenId
        ? generateIdempotencyKey(group.followedUserId, effectiveTokenId, group.side, group.groupKey)
        : `v1_no_token_${group.groupKey}`;

    // Check if budgeted dynamic is active
    const useBudgetedDynamic =
        sizing.budgetedDynamicEnabled &&
        sizing.sizingMode === SizingMode.BUDGETED_DYNAMIC;

    // ─── MIN LEADER TRADE NOTIONAL FILTER ──────────────────────────────────
    // Skip small leader trades (applies only to non-buffer trades)
    if (
        !isBufferSource &&
        sizing.minLeaderTradeNotionalMicros > 0 &&
        group.totalNotionalMicros < BigInt(sizing.minLeaderTradeNotionalMicros)
    ) {
        log.info(
            {
                theirNotional: group.totalNotionalMicros.toString(),
                minLeaderTradeNotional: sizing.minLeaderTradeNotionalMicros,
            },
            "Leader trade below min notional filter, skipping"
        );

        return {
            followedUserId: group.followedUserId,
            tokenId: effectiveTokenId ?? "",
            side: group.side,
            sourceType,
            groupKey: group.groupKey,
            idempotencyKey,
            targetNotionalMicros: BigInt(0),
            targetShareMicros: BigInt(0),
            rawTargetMicros: BigInt(0),
            sizingMetadata: {
                clampedToMin: false,
                clampedToMax: false,
                clampedByBankroll: false,
            },
            theirReferencePriceMicros: group.vwapPriceMicros,
            midPriceMicrosAtDecision: book.midPriceMicros,
            bookSnapshot: createBookSnapshot(book, bookMetadata),
            simulation: createEmptySimulation(book, BigInt(0)),
            decision: "SKIP",
            reasonCodes: [ReasonCodes.LEADER_TRADE_BELOW_MIN_NOTIONAL],
            tradeEventIds: group.tradeEventIds,
            bufferedTradeCount: bufferedTradeCount ?? group.tradeEventIds.length,
            marketId,
        };
    }

    // ─── COMPUTE TARGET NOTIONAL ───────────────────────────────────────────
    let rawTargetMicros: bigint;
    let effectiveRateBps: number | undefined;
    let clampedToRMin = false;
    let clampedToRMax = false;

    if (isBufferSource) {
        // Buffer trades: notional is already scaled, use directly
        rawTargetMicros = group.totalNotionalMicros;
        log.debug({ rawTargetMicros: rawTargetMicros.toString() }, "Using buffer notional as raw target");
    } else if (useBudgetedDynamic && group.followedUserId) {
        // Budgeted dynamic mode
        const rawResult = computeRawTargetNotional(
            group.totalNotionalMicros,
            sizing,
            leaderExposureMicros
        );
        rawTargetMicros = rawResult.rawTargetMicros;
        effectiveRateBps = rawResult.effectiveRateBps;
        clampedToRMin = rawResult.clampedToRMin ?? false;
        clampedToRMax = rawResult.clampedToRMax ?? false;

        log.debug(
            {
                theirNotional: group.totalNotionalMicros.toString(),
                budgetUsdcMicros: sizing.budgetUsdcMicros,
                leaderExposureMicros: leaderExposureMicros?.toString(),
                effectiveRateBps,
                rawTargetMicros: rawTargetMicros.toString(),
                clampedToRMin,
                clampedToRMax,
            },
            "Computed budgeted dynamic raw target"
        );
    } else {
        // Fixed-rate mode
        const rawResult = computeRawTargetNotional(group.totalNotionalMicros, sizing);
        rawTargetMicros = rawResult.rawTargetMicros;
        log.debug(
            {
                theirNotional: group.totalNotionalMicros.toString(),
                copyPctBps: sizing.copyPctNotionalBps,
                rawTargetMicros: rawTargetMicros.toString(),
            },
            "Computed fixed-rate raw target"
        );
    }

    // Apply trade-level clamps
    let targetResult = applyTradeSizingClamps(
        rawTargetMicros,
        portfolioState.equityMicros,
        sizing
    );

    // ─── HARD BUDGET ENFORCEMENT ───────────────────────────────────────────
    let budgetHeadroomMicros: bigint | undefined;
    let budgetCapped = false;

    if (
        useBudgetedDynamic &&
        group.followedUserId &&
        sizing.budgetEnforcement === BudgetEnforcement.HARD &&
        effectiveTokenId
    ) {
        // Check if this trade is reducing exposure
        const isReducing = isReducingExposureSync(
            portfolioState,
            effectiveTokenId,
            group.side
        );

        if (!isReducing) {
            const currentExposureMicros =
                portfolioState.exposureByUser.get(group.followedUserId) ?? BigInt(0);
            const budgetMicros = BigInt(sizing.budgetUsdcMicros);
            budgetHeadroomMicros = budgetMicros - currentExposureMicros;

            log.debug(
                {
                    budgetMicros: budgetMicros.toString(),
                    currentExposureMicros: currentExposureMicros.toString(),
                    budgetHeadroomMicros: budgetHeadroomMicros.toString(),
                    targetNotionalMicros: targetResult.targetNotionalMicros.toString(),
                },
                "Checking HARD budget enforcement"
            );

            if (budgetHeadroomMicros <= BigInt(0)) {
                // No headroom: skip trade
                log.info(
                    {
                        budgetMicros: budgetMicros.toString(),
                        currentExposureMicros: currentExposureMicros.toString(),
                    },
                    "Budget exhausted, skipping trade"
                );

                return {
                    followedUserId: group.followedUserId,
                    tokenId: effectiveTokenId,
                    side: group.side,
                    sourceType,
                    groupKey: group.groupKey,
                    idempotencyKey,
                    targetNotionalMicros: targetResult.targetNotionalMicros,
                    targetShareMicros: BigInt(0),
                    rawTargetMicros,
                    sizingMetadata: {
                        effectiveRateBps,
                        clampedToMin: targetResult.clampedToMin,
                        clampedToMax: targetResult.clampedToMax,
                        clampedByBankroll: targetResult.clampedByBankroll,
                        clampedToRMin,
                        clampedToRMax,
                        budgetHeadroomMicros,
                        leaderExposureMicros,
                    },
                    theirReferencePriceMicros: group.vwapPriceMicros,
                    midPriceMicrosAtDecision: book.midPriceMicros,
                    bookSnapshot: createBookSnapshot(book, bookMetadata),
                    simulation: createEmptySimulation(book, BigInt(0)),
                    decision: "SKIP",
                    reasonCodes: [ReasonCodes.BUDGET_HARD_CAP_EXCEEDED],
                    tradeEventIds: group.tradeEventIds,
                    bufferedTradeCount: bufferedTradeCount ?? group.tradeEventIds.length,
                    marketId,
                };
            }

            // Cap to headroom if target exceeds it
            if (targetResult.targetNotionalMicros > budgetHeadroomMicros) {
                const cappedTarget = budgetHeadroomMicros;

                // Check if capped target is below minimum
                if (cappedTarget < BigInt(sizing.minTradeNotionalMicros)) {
                    log.info(
                        {
                            cappedTarget: cappedTarget.toString(),
                            minTradeNotional: sizing.minTradeNotionalMicros,
                        },
                        "Budget-capped target below min trade notional, skipping"
                    );

                    return {
                        followedUserId: group.followedUserId,
                        tokenId: effectiveTokenId,
                        side: group.side,
                        sourceType,
                        groupKey: group.groupKey,
                        idempotencyKey,
                        targetNotionalMicros: targetResult.targetNotionalMicros,
                        targetShareMicros: BigInt(0),
                        rawTargetMicros,
                        sizingMetadata: {
                            effectiveRateBps,
                            clampedToMin: targetResult.clampedToMin,
                            clampedToMax: targetResult.clampedToMax,
                            clampedByBankroll: targetResult.clampedByBankroll,
                            clampedToRMin,
                            clampedToRMax,
                            budgetCapped: true,
                            budgetHeadroomMicros,
                            leaderExposureMicros,
                        },
                        theirReferencePriceMicros: group.vwapPriceMicros,
                        midPriceMicrosAtDecision: book.midPriceMicros,
                        bookSnapshot: createBookSnapshot(book, bookMetadata),
                        simulation: createEmptySimulation(book, BigInt(0)),
                        decision: "SKIP",
                        reasonCodes: [ReasonCodes.BUDGET_HARD_CAP_EXCEEDED],
                        tradeEventIds: group.tradeEventIds,
                        bufferedTradeCount: bufferedTradeCount ?? group.tradeEventIds.length,
                        marketId,
                    };
                }

                // Apply budget cap
                log.info(
                    {
                        originalTarget: targetResult.targetNotionalMicros.toString(),
                        cappedTarget: cappedTarget.toString(),
                        budgetHeadroom: budgetHeadroomMicros.toString(),
                    },
                    "Capping target to budget headroom"
                );

                targetResult = {
                    ...targetResult,
                    targetNotionalMicros: cappedTarget,
                };
                budgetCapped = true;
            }
        }
    }

    // ─── COMPUTE PRICE BOUNDS ──────────────────────────────────────────────
    const priceBounds = computePriceBounds(
        group.side,
        group.vwapPriceMicros,
        book.midPriceMicros,
        guardrails
    );

    // ─── SIMULATE FILLS ────────────────────────────────────────────────────
    const targetShareMicros = computeTargetShares(
        targetResult.targetNotionalMicros,
        group.vwapPriceMicros
    );

    const simulation = simulateFromNormalizedBook(
        book,
        group.side,
        targetShareMicros,
        priceBounds.maxPriceMicros,
        priceBounds.minPriceMicros
    );

    // Log decision inputs
    log.info(
        {
            side: group.side,
            theirRefPriceMicros: group.vwapPriceMicros,
            theirNotionalMicros: group.totalNotionalMicros.toString(),
            bestBidMicros: book.bestBidMicros,
            bestAskMicros: book.bestAskMicros,
            midPriceMicros: book.midPriceMicros,
            spreadMicros: book.spreadMicros,
            maxPriceMicros: priceBounds.maxPriceMicros,
            minPriceMicros: priceBounds.minPriceMicros,
            targetNotionalMicros: targetResult.targetNotionalMicros.toString(),
            targetShareMicros: targetShareMicros.toString(),
            rawTargetMicros: rawTargetMicros.toString(),
            clampedToMin: targetResult.clampedToMin,
            clampedToMax: targetResult.clampedToMax,
            clampedByBankroll: targetResult.clampedByBankroll,
            sizingMode: sizing.sizingMode,
            budgetedDynamicEnabled: sizing.budgetedDynamicEnabled,
            budgetEnforcement: sizing.budgetEnforcement,
            ...(useBudgetedDynamic && {
                budgetUsdcMicros: sizing.budgetUsdcMicros,
                leaderExposureMicros: leaderExposureMicros?.toString(),
                effectiveRateBps,
                clampedToRMin,
                clampedToRMax,
                budgetHeadroomMicros: budgetHeadroomMicros?.toString(),
                budgetCapped,
            }),
            availableNotionalMicros: simulation.availableNotionalMicros.toString(),
            filledNotionalMicros: simulation.filledNotionalMicros.toString(),
            filledShareMicros: simulation.filledShareMicros.toString(),
            filledRatioBps: simulation.filledRatioBps,
            simulationSuccess: simulation.success,
            bookSource: bookMetadata.source,
            bookStale: bookMetadata.stale,
            sourceType,
            isBufferSource,
            idempotencyKey,
        },
        "Copy attempt decision inputs"
    );

    if (!simulation.success) {
        log.warn({ error: simulation.error }, "Book simulation failed");
        reasonCodes.push(ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS);
    }

    // ─── GUARDRAIL CHECKS ──────────────────────────────────────────────────
    if (simulation.success) {
        // Optional: max buy cost per share (GLOBAL only)
        if (portfolioScope === PortfolioScope.EXEC_GLOBAL) {
            const maxBuyCostCheck = checkMaxBuyCostPerShare(
                group.side,
                simulation.vwapPriceMicros,
                guardrails
            );
            if (!maxBuyCostCheck.passed) {
                reasonCodes.push(...maxBuyCostCheck.reasonCodes);
            }
        }

        // Spread filter
        const spreadCheck = checkSpreadFilter(simulation.spreadMicros, guardrails);
        if (!spreadCheck.passed) {
            reasonCodes.push(...spreadCheck.reasonCodes);
        }

        // Depth requirement
        const depthCheck = checkDepthRequirement(
            simulation.availableNotionalMicros,
            targetResult.targetNotionalMicros,
            guardrails
        );
        if (!depthCheck.passed) {
            reasonCodes.push(...depthCheck.reasonCodes);
        }

        // Price protection
        if (simulation.filledShareMicros > BigInt(0)) {
            const priceCheck = checkPriceProtection(
                group.side,
                simulation.vwapPriceMicros,
                group.vwapPriceMicros,
                simulation.midPriceMicros,
                guardrails
            );
            if (!priceCheck.passed) {
                reasonCodes.push(...priceCheck.reasonCodes);
            }
        }

        // Check if reducing exposure
        const isReducing = effectiveTokenId
            ? isReducingExposureSync(portfolioState, effectiveTokenId, group.side)
            : false;

        // Circuit breakers (skip if reducing)
        if (!isReducing) {
            const circuitCheck = checkCircuitBreakers(portfolioState, guardrails);
            if (circuitCheck.tripped) {
                reasonCodes.push(...circuitCheck.reasonCodes);
            }
        }

        // Exposure caps (skip if reducing)
        if (!isReducing) {
            const exposureCheck = checkExposureCaps(
                portfolioState,
                simulation.filledNotionalMicros,
                marketId,
                group.followedUserId,
                guardrails,
                portfolioScope === PortfolioScope.EXEC_GLOBAL ? "GLOBAL" : "USER"
            );
            if (!exposureCheck.passed) {
                reasonCodes.push(...exposureCheck.reasonCodes);
            }
        }
    }

    // Check for zero fill
    if (simulation.success && simulation.filledShareMicros === BigInt(0)) {
        reasonCodes.push(ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS);
    }

    // ─── DETERMINE DECISION ────────────────────────────────────────────────
    const uniqueReasons = [...new Set(reasonCodes)];
    const decision: CopyDecisionType = uniqueReasons.length === 0 ? "EXECUTE" : "SKIP";

    log.info(
        {
            decision,
            reasonCodes: uniqueReasons,
            targetNotional: targetResult.targetNotionalMicros.toString(),
            filledNotional: simulation.filledNotionalMicros.toString(),
            filledRatio: simulation.filledRatioBps,
            idempotencyKey,
        },
        "Copy attempt decision"
    );

    return {
        followedUserId: group.followedUserId,
        tokenId: effectiveTokenId ?? "",
        side: group.side,
        sourceType,
        groupKey: group.groupKey,
        idempotencyKey,
        targetNotionalMicros: targetResult.targetNotionalMicros,
        targetShareMicros,
        rawTargetMicros,
        sizingMetadata: {
            effectiveRateBps,
            clampedToMin: targetResult.clampedToMin,
            clampedToMax: targetResult.clampedToMax,
            clampedByBankroll: targetResult.clampedByBankroll,
            clampedToRMin,
            clampedToRMax,
            budgetCapped,
            budgetHeadroomMicros,
            leaderExposureMicros,
        },
        maxBuyPriceMicros: priceBounds.maxPriceMicros,
        minSellPriceMicros: priceBounds.minPriceMicros,
        theirReferencePriceMicros: group.vwapPriceMicros,
        midPriceMicrosAtDecision: book.midPriceMicros,
        bookSnapshot: createBookSnapshot(book, bookMetadata),
        simulation,
        decision,
        reasonCodes: uniqueReasons,
        tradeEventIds: group.tradeEventIds,
        bufferedTradeCount: bufferedTradeCount ?? group.tradeEventIds.length,
        marketId,
    };
}

/**
 * Synchronous check if a trade is reducing exposure.
 * Uses portfolio state's position data instead of DB query.
 */
function isReducingExposureSync(
    portfolioState: PortfolioState,
    assetId: string,
    side: TradeSide
): boolean {
    const currentPosition = portfolioState.positionByAssetId.get(assetId) ?? BigInt(0);

    // SELL reduces a long position
    if (side === TradeSide.SELL && currentPosition > BigInt(0)) {
        return true;
    }

    // BUY reduces a short position (if shorts exist)
    if (side === TradeSide.BUY && currentPosition < BigInt(0)) {
        return true;
    }

    return false;
}
