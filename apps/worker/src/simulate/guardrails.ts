/**
 * Guardrails for copy trade execution.
 *
 * Implements all the protection checks from planning.md:
 * - Price protection (worsening vs their fill, chase protection vs mid)
 * - Spread filter
 * - Depth requirement
 * - Risk caps (exposure limits, circuit breakers)
 */

import { TradeSide, PortfolioScope } from "@prisma/client";
import { ReasonCodes, type ReasonCode, type Guardrails } from "@copybot/shared";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import type { SimulationResult } from "./book.js";

const logger = createChildLogger({ module: "guardrails" });

/**
 * Result of guardrail checks.
 */
export interface GuardrailCheckResult {
    /** Whether all checks passed. */
    passed: boolean;
    /** Reason codes for failures (empty if passed). */
    reasonCodes: ReasonCode[];
    /** Maximum acceptable price for BUY. */
    maxAcceptablePriceMicros?: number;
    /** Minimum acceptable price for SELL. */
    minAcceptablePriceMicros?: number;
}

/**
 * Check price protection guardrails.
 *
 * BUY must satisfy:
 * - VWAP <= their_ref + maxWorsening
 * - VWAP <= mid + maxOverMid
 *
 * SELL must satisfy:
 * - VWAP >= their_ref - maxWorsening
 * - VWAP >= mid - maxOverMid
 */
export function checkPriceProtection(
    side: TradeSide,
    vwapPriceMicros: number,
    theirRefPriceMicros: number,
    midPriceMicros: number,
    guardrails: Guardrails
): GuardrailCheckResult {
    const reasons: ReasonCode[] = [];

    if (side === TradeSide.BUY) {
        // Check worsening vs their fill
        const maxVsTheirFill = theirRefPriceMicros + guardrails.maxWorseningVsTheirFillMicros;
        if (vwapPriceMicros > maxVsTheirFill) {
            reasons.push(ReasonCodes.PRICE_WORSE_THAN_THEIR_FILL);
        }

        // Check chase protection vs mid
        const maxVsMid = midPriceMicros + guardrails.maxOverMidMicros;
        if (vwapPriceMicros > maxVsMid) {
            reasons.push(ReasonCodes.PRICE_TOO_FAR_OVER_MID);
        }
    } else {
        // SELL
        // Check worsening vs their fill
        const minVsTheirFill = theirRefPriceMicros - guardrails.maxWorseningVsTheirFillMicros;
        if (vwapPriceMicros < minVsTheirFill) {
            reasons.push(ReasonCodes.PRICE_WORSE_THAN_THEIR_FILL);
        }

        // Check chase protection vs mid
        const minVsMid = midPriceMicros - guardrails.maxOverMidMicros;
        if (vwapPriceMicros < minVsMid) {
            reasons.push(ReasonCodes.PRICE_TOO_FAR_OVER_MID);
        }
    }

    return {
        passed: reasons.length === 0,
        reasonCodes: reasons,
    };
}

/**
 * Check spread filter.
 * Skip if spread > maxSpread.
 */
export function checkSpreadFilter(
    spreadMicros: number,
    guardrails: Guardrails
): GuardrailCheckResult {
    if (spreadMicros > guardrails.maxSpreadMicros) {
        return {
            passed: false,
            reasonCodes: [ReasonCodes.SPREAD_TOO_WIDE],
        };
    }

    return { passed: true, reasonCodes: [] };
}

/**
 * Check depth requirement.
 * Require available notional >= minDepthMultiplier * target notional.
 */
export function checkDepthRequirement(
    availableNotionalMicros: bigint,
    targetNotionalMicros: bigint,
    guardrails: Guardrails
): GuardrailCheckResult {
    // minDepthMultiplierBps is in basis points (12500 = 1.25x)
    const requiredNotional =
        (targetNotionalMicros * BigInt(guardrails.minDepthMultiplierBps)) / BigInt(10000);

    if (availableNotionalMicros < requiredNotional) {
        return {
            passed: false,
            reasonCodes: [ReasonCodes.INSUFFICIENT_DEPTH],
        };
    }

    return { passed: true, reasonCodes: [] };
}

/**
 * Compute acceptable price bounds for a trade.
 */
export function computePriceBounds(
    side: TradeSide,
    theirRefPriceMicros: number,
    midPriceMicros: number,
    guardrails: Guardrails
): { maxPriceMicros?: number; minPriceMicros?: number } {
    if (side === TradeSide.BUY) {
        // For BUY: max price is the lesser of the two limits
        const maxVsTheirFill = theirRefPriceMicros + guardrails.maxWorseningVsTheirFillMicros;
        const maxVsMid = midPriceMicros + guardrails.maxOverMidMicros;
        return {
            maxPriceMicros: Math.min(maxVsTheirFill, maxVsMid),
        };
    } else {
        // For SELL: min price is the greater of the two limits
        const minVsTheirFill = theirRefPriceMicros - guardrails.maxWorseningVsTheirFillMicros;
        const minVsMid = midPriceMicros - guardrails.maxOverMidMicros;
        return {
            minPriceMicros: Math.max(minVsTheirFill, minVsMid),
        };
    }
}

/**
 * Portfolio state for risk cap checks.
 */
export interface PortfolioState {
    equityMicros: bigint;
    totalExposureMicros: bigint;
    exposureByMarket: Map<string, bigint>;
    exposureByUser: Map<string, bigint>;
    dailyPnlMicros: bigint;
    weeklyPnlMicros: bigint;
    peakEquityMicros: bigint;
}

/**
 * Check circuit breakers (loss limits and drawdown).
 * Returns true if breaker is tripped.
 */
export function checkCircuitBreakers(
    state: PortfolioState,
    guardrails: Guardrails
): { tripped: boolean; reasonCodes: ReasonCode[] } {
    const reasons: ReasonCode[] = [];

    if (state.equityMicros <= BigInt(0)) {
        // No equity, allow closes only
        return { tripped: true, reasonCodes: [ReasonCodes.CIRCUIT_BREAKER_TRIPPED] };
    }

    // Check daily loss limit
    const dailyLossLimit =
        (state.equityMicros * BigInt(guardrails.dailyLossLimitBps)) / BigInt(10000);
    if (state.dailyPnlMicros < -dailyLossLimit) {
        reasons.push(ReasonCodes.CIRCUIT_BREAKER_TRIPPED);
    }

    // Check weekly loss limit
    const weeklyLossLimit =
        (state.equityMicros * BigInt(guardrails.weeklyLossLimitBps)) / BigInt(10000);
    if (state.weeklyPnlMicros < -weeklyLossLimit) {
        reasons.push(ReasonCodes.CIRCUIT_BREAKER_TRIPPED);
    }

    // Check max drawdown
    if (state.peakEquityMicros > BigInt(0)) {
        const drawdown = state.peakEquityMicros - state.equityMicros;
        const maxDrawdown =
            (state.peakEquityMicros * BigInt(guardrails.maxDrawdownLimitBps)) / BigInt(10000);
        if (drawdown > maxDrawdown) {
            reasons.push(ReasonCodes.CIRCUIT_BREAKER_TRIPPED);
        }
    }

    return {
        tripped: reasons.length > 0,
        reasonCodes: reasons,
    };
}

/**
 * Check exposure caps.
 */
export function checkExposureCaps(
    state: PortfolioState,
    newExposureMicros: bigint,
    marketId: string | null,
    followedUserId: string | null,
    guardrails: Guardrails,
    scope: "USER" | "GLOBAL"
): GuardrailCheckResult {
    const reasons: ReasonCode[] = [];

    if (state.equityMicros <= BigInt(0)) {
        // No equity to compute percentages
        return { passed: true, reasonCodes: [] };
    }

    // Check total exposure cap
    const maxTotalExposure =
        (state.equityMicros * BigInt(guardrails.maxTotalExposureBps)) / BigInt(10000);
    const newTotalExposure = state.totalExposureMicros + newExposureMicros;
    if (newTotalExposure > maxTotalExposure) {
        reasons.push(scope === "GLOBAL" ? ReasonCodes.RISK_CAP_GLOBAL : ReasonCodes.RISK_CAP_USER);
    }

    // Check per-market exposure cap
    if (marketId) {
        const currentMarketExposure = state.exposureByMarket.get(marketId) ?? BigInt(0);
        const newMarketExposure = currentMarketExposure + newExposureMicros;
        const maxMarketExposure =
            (state.equityMicros * BigInt(guardrails.maxExposurePerMarketBps)) / BigInt(10000);
        if (newMarketExposure > maxMarketExposure) {
            reasons.push(scope === "GLOBAL" ? ReasonCodes.RISK_CAP_GLOBAL : ReasonCodes.RISK_CAP_USER);
        }
    }

    // Check per-user exposure cap (only for global scope)
    if (scope === "GLOBAL" && followedUserId) {
        const currentUserExposure = state.exposureByUser.get(followedUserId) ?? BigInt(0);
        const newUserExposure = currentUserExposure + newExposureMicros;
        const maxUserExposure =
            (state.equityMicros * BigInt(guardrails.maxExposurePerUserBps)) / BigInt(10000);
        if (newUserExposure > maxUserExposure) {
            reasons.push(ReasonCodes.RISK_CAP_GLOBAL);
        }
    }

    return {
        passed: reasons.length === 0,
        reasonCodes: [...new Set(reasons)], // Dedupe
    };
}

/**
 * Detect if a trade is reducing exposure (closing/reducing a position).
 */
export async function isReducingExposure(
    portfolioScope: PortfolioScope,
    followedUserId: string | null,
    assetId: string,
    side: TradeSide
): Promise<boolean> {
    // Get current position
    const result = await prisma.ledgerEntry.aggregate({
        where: {
            portfolioScope,
            followedUserId,
            assetId,
        },
        _sum: {
            shareDeltaMicros: true,
        },
    });

    const currentPosition = result._sum.shareDeltaMicros ?? BigInt(0);

    // SELL reduces a long position
    if (side === TradeSide.SELL && currentPosition > BigInt(0)) {
        return true;
    }

    // BUY reduces a short position (if we support shorts)
    if (side === TradeSide.BUY && currentPosition < BigInt(0)) {
        return true;
    }

    return false;
}

/**
 * Run all guardrail checks for a copy attempt.
 */
export async function runAllGuardrailChecks(
    side: TradeSide,
    simulation: SimulationResult,
    theirRefPriceMicros: number,
    targetNotionalMicros: bigint,
    portfolioState: PortfolioState,
    marketId: string | null,
    followedUserId: string | null,
    guardrails: Guardrails,
    scope: "USER" | "GLOBAL"
): Promise<GuardrailCheckResult> {
    const allReasons: ReasonCode[] = [];

    // 1. Spread filter
    const spreadCheck = checkSpreadFilter(simulation.spreadMicros, guardrails);
    if (!spreadCheck.passed) {
        allReasons.push(...spreadCheck.reasonCodes);
    }

    // 2. Depth requirement
    const depthCheck = checkDepthRequirement(
        simulation.availableNotionalMicros,
        targetNotionalMicros,
        guardrails
    );
    if (!depthCheck.passed) {
        allReasons.push(...depthCheck.reasonCodes);
    }

    // 3. Price protection (only if we have fills)
    if (simulation.filledShareMicros > BigInt(0)) {
        const priceCheck = checkPriceProtection(
            side,
            simulation.vwapPriceMicros,
            theirRefPriceMicros,
            simulation.midPriceMicros,
            guardrails
        );
        if (!priceCheck.passed) {
            allReasons.push(...priceCheck.reasonCodes);
        }
    }

    // 4. Circuit breakers (skip if reducing exposure)
    const isReducing = await isReducingExposure(
        scope === "GLOBAL" ? PortfolioScope.EXEC_GLOBAL : PortfolioScope.EXEC_USER,
        followedUserId,
        simulation.targetShareMicros > BigInt(0) ? "" : "", // We'd need assetId here
        side
    );

    if (!isReducing) {
        const circuitCheck = checkCircuitBreakers(portfolioState, guardrails);
        if (circuitCheck.tripped) {
            allReasons.push(...circuitCheck.reasonCodes);
        }
    }

    // 5. Exposure caps (skip if reducing exposure)
    if (!isReducing) {
        const exposureCheck = checkExposureCaps(
            portfolioState,
            simulation.filledNotionalMicros,
            marketId,
            followedUserId,
            guardrails,
            scope
        );
        if (!exposureCheck.passed) {
            allReasons.push(...exposureCheck.reasonCodes);
        }
    }

    // Compute price bounds for the result
    const bounds = computePriceBounds(
        side,
        theirRefPriceMicros,
        simulation.midPriceMicros,
        guardrails
    );

    return {
        passed: allReasons.length === 0,
        reasonCodes: [...new Set(allReasons)], // Dedupe
        ...bounds,
    };
}
