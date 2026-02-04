/**
 * Shared Decision Engine for Copy Trading.
 *
 * This module extracts the decision logic from execution, allowing both
 * paper and live executors to share the same decision path.
 *
 * The decision engine is stateless and deterministic:
 * - Takes inputs (event group, config, portfolio state, book snapshot)
 * - Produces a CopyIntent (decision + all data needed for execution)
 *
 * The executor then takes the CopyIntent and executes it mode-specifically.
 */

import { TradeSide, TradingMode, PortfolioScope } from "@prisma/client";
import { ReasonCodes, type ReasonCode, type Guardrails, type LiveGuardrails, type Sizing } from "@copybot/shared";
import { createChildLogger } from "../log/logger.js";
import { generateIdempotencyKey } from "./idempotency.js";
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
import {
    computeTargetShares,
    computeRawTargetNotional,
    applyTradeSizingClamps,
} from "../simulate/sizing.js";
import {
    simulateFromNormalizedBook,
    type SimulationResult,
} from "../simulate/book.js";
import type { NormalizedBook } from "../simulate/bookUtils.js";
import type { TradeEventGroup, CopySourceType } from "../simulate/types.js";

const logger = createChildLogger({ module: "decision-engine" });

// ─── CopyIntent Types ──────────────────────────────────────────────────────────

/**
 * Book snapshot metadata for the decision.
 */
export interface BookSnapshot {
    book: NormalizedBook;
    source: "WS" | "REST";
    stale: boolean;
    ageMs: number;
    usedRestFallback: boolean;
}

/**
 * Decision outcome: EXECUTE or SKIP.
 */
export type CopyDecisionType = "EXECUTE" | "SKIP";

/**
 * A CopyIntent represents the decision for a copy trade, independent of execution mode.
 *
 * Both paper and live executors consume this intent and execute it mode-specifically.
 */
export interface CopyIntent {
    // ─── Identity ────────────────────────────────────────────────────────────
    /** Deterministic key for idempotent execution */
    idempotencyKey: string;
    /** Followed user ID */
    followedUserId: string;
    /** Outcome token ID (effective: rawTokenId ?? assetId) */
    tokenId: string;
    /** Trade side */
    side: TradeSide;
    /** Market ID (if known) */
    marketId: string | null;
    /** Group key (for deduplication) */
    groupKey: string;
    /** Source type */
    sourceType: CopySourceType;
    /** Number of trades in this intent (for buffer sources) */
    tradeCount: number;

    // ─── Sizing ──────────────────────────────────────────────────────────────
    /** Target notional in micros (after clamps) */
    targetNotionalMicros: bigint;
    /** Target shares in micros */
    targetShareMicros: bigint;
    /** Raw target before clamps (for observability) */
    rawTargetMicros: bigint;
    /** Whether target was clamped to minimum */
    clampedToMin: boolean;
    /** Whether target was clamped to maximum */
    clampedToMax: boolean;
    /** Whether target was clamped by bankroll % */
    clampedByBankroll: boolean;

    // ─── Price Protection Bounds ─────────────────────────────────────────────
    /**
     * Maximum price we're willing to pay (BUY) or null (SELL).
     * Derived from guardrails + their reference price + mid.
     */
    maxBuyPriceMicros: number | null;
    /**
     * Minimum price we're willing to accept (SELL) or null (BUY).
     * Derived from guardrails + their reference price + mid.
     */
    minSellPriceMicros: number | null;

    // ─── Decision ────────────────────────────────────────────────────────────
    /** The decision: EXECUTE or SKIP */
    decision: CopyDecisionType;
    /** Reason codes if SKIP (or empty if EXECUTE) */
    reasonCodes: ReasonCode[];

    // ─── Simulation Results (Paper) ──────────────────────────────────────────
    /** Simulated fill results (paper simulation) */
    simulation: SimulationResult | null;

    // ─── Observability ───────────────────────────────────────────────────────
    /** Their reference price (leader VWAP) */
    theirReferencePriceMicros: number;
    /** Mid price at decision time */
    midPriceMicrosAtDecision: number;
    /** Best bid at decision time */
    bestBidMicrosAtDecision: number;
    /** Best ask at decision time */
    bestAskMicrosAtDecision: number;
    /** Spread at decision time */
    spreadMicrosAtDecision: number;
    /** Book source (WS or REST) */
    bookSource: "WS" | "REST";
    /** Book age in ms at decision time */
    bookAgeMs: number;
    /** Whether REST fallback was used */
    usedRestFallback: boolean;
    /** Whether book was stale */
    bookWasStale: boolean;
}

// ─── Decision Inputs ───────────────────────────────────────────────────────────

/**
 * Inputs required for the decision engine.
 */
export interface DecisionInputs {
    /** The trade event group */
    group: TradeEventGroup;
    /** Trading mode (PAPER or LIVE) */
    mode: TradingMode;
    /** Portfolio scope */
    portfolioScope: PortfolioScope;
    /** Source type (IMMEDIATE, BUFFER, AGGREGATOR) */
    sourceType: CopySourceType;
    /** Number of trades (for buffer sources) */
    tradeCount: number;
    /** Base guardrails config */
    guardrails: Guardrails;
    /** Live-specific guardrails (used if mode=LIVE) */
    liveGuardrails: LiveGuardrails;
    /** Sizing config */
    sizing: Sizing;
    /** Current portfolio state */
    portfolioState: PortfolioState;
    /** Whether this trade reduces existing exposure (used to skip some guardrails) */
    isReducingExposure: boolean;
    /** Book snapshot with metadata */
    bookSnapshot: BookSnapshot;
    /** Resolved market ID (if available) */
    resolvedMarketId: string | null;
}

// ─── Decision Engine ───────────────────────────────────────────────────────────

/**
 * Make a copy trading decision.
 *
 * This is the core decision function that both paper and live executors use.
 * It is deterministic and does not perform any I/O (except logging).
 *
 * @param inputs - All inputs needed for the decision
 * @returns A CopyIntent representing the decision
 */
export function makeDecision(inputs: DecisionInputs): CopyIntent {
    const {
        group,
        mode,
        portfolioScope,
        sourceType,
        tradeCount,
        guardrails,
        liveGuardrails,
        sizing,
        portfolioState,
        isReducingExposure,
        bookSnapshot,
        resolvedMarketId,
    } = inputs;

    const effectiveTokenId = group.rawTokenId ?? group.assetId;
    const followedUserId = group.followedUserId;
    const isBufferSource = sourceType === "BUFFER";

    const log = logger.child({
        groupKey: group.groupKey,
        mode,
        scope: portfolioScope,
        followedUserId,
        side: group.side,
        tokenId: effectiveTokenId,
    });

    const reasonCodes: ReasonCode[] = [];

    // ─── Validate Token ID ───────────────────────────────────────────────────
    if (!effectiveTokenId) {
        log.error("No token ID available for decision");
        return createSkipIntent(
            inputs,
            effectiveTokenId ?? "unknown",
            [ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS],
            null
        );
    }

    // ─── Generate Idempotency Key ────────────────────────────────────────────
    const idempotencyKey = generateIdempotencyKey(
        followedUserId,
        effectiveTokenId,
        group.side,
        group.groupKey
    );

    // ─── Min Leader Trade Filter ─────────────────────────────────────────────
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
        return createSkipIntent(
            inputs,
            effectiveTokenId,
            [ReasonCodes.LEADER_TRADE_BELOW_MIN_NOTIONAL],
            null
        );
    }

    // ─── Compute Raw Target Notional ─────────────────────────────────────────
    let rawTargetMicros: bigint;

    if (isBufferSource) {
        // Buffer trades: notional is already scaled
        rawTargetMicros = group.totalNotionalMicros;
    } else {
        // Fixed-rate mode: use standard formula
        const rawResult = computeRawTargetNotional(group.totalNotionalMicros, sizing);
        rawTargetMicros = rawResult.rawTargetMicros;
    }

    // ─── Apply Trade-Level Clamps ────────────────────────────────────────────
    const targetResult = applyTradeSizingClamps(
        rawTargetMicros,
        portfolioState.equityMicros,
        sizing
    );

    // ─── Extract Book Metrics ────────────────────────────────────────────────
    const { book } = bookSnapshot;
    const { midPriceMicros, bestBidMicros, bestAskMicros, spreadMicros } = book;

    // ─── Compute Price Bounds ────────────────────────────────────────────────
    // For live mode, we could apply different bounds based on liveGuardrails
    // For now, use the same bounds derivation
    const priceBounds = computePriceBounds(
        group.side,
        group.vwapPriceMicros,
        midPriceMicros,
        guardrails
    );

    // ─── Simulate Fills ──────────────────────────────────────────────────────
    const targetShareMicros = computeTargetShares(targetResult.targetNotionalMicros, group.vwapPriceMicros);
    const simulation = simulateFromNormalizedBook(
        book,
        group.side,
        targetShareMicros,
        priceBounds.maxPriceMicros,
        priceBounds.minPriceMicros
    );

    // ─── Log Decision Inputs ─────────────────────────────────────────────────
    log.info(
        {
            side: group.side,
            theirRefPriceMicros: group.vwapPriceMicros,
            theirNotionalMicros: group.totalNotionalMicros.toString(),
            bestBidMicros,
            bestAskMicros,
            midPriceMicros,
            spreadMicros,
            maxPriceMicros: priceBounds.maxPriceMicros,
            minPriceMicros: priceBounds.minPriceMicros,
            targetNotionalMicros: targetResult.targetNotionalMicros.toString(),
            targetShareMicros: targetShareMicros.toString(),
            rawTargetMicros: rawTargetMicros.toString(),
            clampedToMin: targetResult.clampedToMin,
            clampedToMax: targetResult.clampedToMax,
            clampedByBankroll: targetResult.clampedByBankroll,
            availableNotionalMicros: simulation.availableNotionalMicros.toString(),
            filledNotionalMicros: simulation.filledNotionalMicros.toString(),
            simulationSuccess: simulation.success,
            bookSource: bookSnapshot.source,
            bookAgeMs: bookSnapshot.ageMs,
            usedRestFallback: bookSnapshot.usedRestFallback,
            sourceType,
            isBufferSource,
            mode,
        },
        "Decision engine inputs"
    );

    // ─── Check Simulation Success ────────────────────────────────────────────
    if (!simulation.success) {
        log.warn({ error: simulation.error }, "Book simulation failed");
        reasonCodes.push(ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS);
    }

    // ─── Run Guardrail Checks ────────────────────────────────────────────────
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

        // Circuit breakers (if not reducing exposure)
        if (!isReducingExposure) {
            const circuitCheck = checkCircuitBreakers(portfolioState, guardrails);
            if (circuitCheck.tripped) {
                reasonCodes.push(...circuitCheck.reasonCodes);
            }
        }

        // Exposure caps
        if (!isReducingExposure) {
            const exposureCheck = checkExposureCaps(
                portfolioState,
                simulation.filledNotionalMicros,
                resolvedMarketId,
                followedUserId,
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

    // ─── Determine Decision ──────────────────────────────────────────────────
    const uniqueReasons = [...new Set(reasonCodes)];
    const decision: CopyDecisionType = uniqueReasons.length === 0 ? "EXECUTE" : "SKIP";

    log.info(
        {
            decision,
            reasonCodes: uniqueReasons,
            targetNotional: targetResult.targetNotionalMicros.toString(),
            filledNotional: simulation.filledNotionalMicros.toString(),
            filledRatio: simulation.filledRatioBps,
        },
        "Decision engine result"
    );

    // ─── Build CopyIntent ────────────────────────────────────────────────────
    return {
        idempotencyKey,
        followedUserId,
        tokenId: effectiveTokenId,
        side: group.side,
        marketId: resolvedMarketId,
        groupKey: group.groupKey,
        sourceType,
        tradeCount,

        targetNotionalMicros: targetResult.targetNotionalMicros,
        targetShareMicros,
        rawTargetMicros,
        clampedToMin: targetResult.clampedToMin,
        clampedToMax: targetResult.clampedToMax,
        clampedByBankroll: targetResult.clampedByBankroll,

        maxBuyPriceMicros: group.side === TradeSide.BUY ? (priceBounds.maxPriceMicros ?? null) : null,
        minSellPriceMicros: group.side === TradeSide.SELL ? (priceBounds.minPriceMicros ?? null) : null,

        decision,
        reasonCodes: uniqueReasons,

        simulation,

        theirReferencePriceMicros: group.vwapPriceMicros,
        midPriceMicrosAtDecision: midPriceMicros,
        bestBidMicrosAtDecision: bestBidMicros,
        bestAskMicrosAtDecision: bestAskMicros,
        spreadMicrosAtDecision: spreadMicros,
        bookSource: bookSnapshot.source,
        bookAgeMs: bookSnapshot.ageMs,
        usedRestFallback: bookSnapshot.usedRestFallback,
        bookWasStale: bookSnapshot.stale,
    };
}

/**
 * Create a SKIP intent with the given reason codes.
 */
function createSkipIntent(
    inputs: DecisionInputs,
    tokenId: string,
    reasonCodes: ReasonCode[],
    simulation: SimulationResult | null
): CopyIntent {
    const { group, sourceType, tradeCount, bookSnapshot } = inputs;
    const { book } = bookSnapshot;

    return {
        idempotencyKey: generateIdempotencyKey(
            group.followedUserId,
            tokenId,
            group.side,
            group.groupKey
        ),
        followedUserId: group.followedUserId,
        tokenId,
        side: group.side,
        marketId: inputs.resolvedMarketId,
        groupKey: group.groupKey,
        sourceType,
        tradeCount,

        targetNotionalMicros: BigInt(0),
        targetShareMicros: BigInt(0),
        rawTargetMicros: BigInt(0),
        clampedToMin: false,
        clampedToMax: false,
        clampedByBankroll: false,

        maxBuyPriceMicros: null,
        minSellPriceMicros: null,

        decision: "SKIP",
        reasonCodes,

        simulation,

        theirReferencePriceMicros: group.vwapPriceMicros,
        midPriceMicrosAtDecision: book.midPriceMicros,
        bestBidMicrosAtDecision: book.bestBidMicros,
        bestAskMicrosAtDecision: book.bestAskMicros,
        spreadMicrosAtDecision: book.spreadMicros,
        bookSource: bookSnapshot.source,
        bookAgeMs: bookSnapshot.ageMs,
        usedRestFallback: bookSnapshot.usedRestFallback,
        bookWasStale: bookSnapshot.stale,
    };
}

// ─── Live-Specific Decision Adjustments ────────────────────────────────────────

/**
 * Check if the book is fresh enough for live execution.
 *
 * @param bookAgeMs - Age of the book in milliseconds
 * @param liveGuardrails - Live guardrails config
 * @returns True if book is fresh enough
 */
export function isBookFreshEnoughForLive(
    bookAgeMs: number,
    liveGuardrails: LiveGuardrails
): boolean {
    return bookAgeMs <= liveGuardrails.liveBookFreshnessMs;
}

/**
 * Compute live execution price bounds with slippage tolerance.
 *
 * For BUY: maxPrice = bestAsk * (1 + slippageBps/10000)
 * For SELL: minPrice = bestBid * (1 - slippageBps/10000)
 *
 * @param side - Trade side
 * @param bestBidMicros - Best bid price
 * @param bestAskMicros - Best ask price
 * @param liveGuardrails - Live guardrails config
 * @returns Price bounds for live execution
 */
export function computeLiveSlippageBounds(
    side: TradeSide,
    bestBidMicros: number,
    bestAskMicros: number,
    liveGuardrails: LiveGuardrails
): { maxPriceMicros: number | null; minPriceMicros: number | null } {
    if (side === TradeSide.BUY) {
        const slippageFactor = 1 + liveGuardrails.liveSlippageBpsBuy / 10000;
        const maxPrice = Math.floor(bestAskMicros * slippageFactor);
        return { maxPriceMicros: maxPrice, minPriceMicros: null };
    } else {
        const slippageFactor = 1 - liveGuardrails.liveSlippageBpsSell / 10000;
        const minPrice = Math.ceil(bestBidMicros * slippageFactor);
        return { maxPriceMicros: null, minPriceMicros: minPrice };
    }
}
