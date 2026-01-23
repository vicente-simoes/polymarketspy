/**
 * Trade sizing calculations for copy trading.
 *
 * Computes target notional based on:
 * - Their group notional * copy percentage (default 1%)
 * - Clamped to min/max bounds
 * - Further clamped by bankroll percentage
 */

import { SizingMode, type Sizing } from "@copybot/shared";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "sizing" });

/**
 * Result of target notional computation.
 */
export interface TargetNotionalResult {
    /** Target notional in micros (6 decimals). */
    targetNotionalMicros: bigint;
    /** Original unclamped target before min/max. */
    rawTargetMicros: bigint;
    /** Whether the target was clamped to minimum. */
    clampedToMin: boolean;
    /** Whether the target was clamped to maximum. */
    clampedToMax: boolean;
    /** Whether the target was clamped by bankroll limit. */
    clampedByBankroll: boolean;
}

/**
 * Result of budgeted dynamic raw target computation.
 */
export interface BudgetedDynamicRawResult {
    /** Raw target notional in micros (before trade-level clamps). */
    rawTargetMicros: bigint;
    /** Effective copy rate in bps (for observability). */
    effectiveRateBps: number;
    /** Whether rate was clamped to rMin. */
    clampedToRMin: boolean;
    /** Whether rate was clamped to rMax. */
    clampedToRMax: boolean;
}

/**
 * Compute raw target notional using budgeted dynamic sizing.
 *
 * Formula:
 *   r_u = clamp(budget / leaderExposure, rMin, rMax)
 *   raw_target = their_notional * r_u
 *
 * If leaderExposure <= 0, uses rMax to avoid division by zero.
 *
 * @param theirNotionalMicros - The followed user's trade notional in micros
 * @param budgetUsdcMicros - Your budget allocated to this leader in micros
 * @param leaderExposureMicros - Leader's total exposure in micros
 * @param rMinBps - Minimum effective rate in bps (floor)
 * @param rMaxBps - Maximum effective rate in bps (ceiling)
 */
export function computeBudgetedDynamicRawTargetMicros(
    theirNotionalMicros: bigint,
    budgetUsdcMicros: bigint,
    leaderExposureMicros: bigint,
    rMinBps: number,
    rMaxBps: number
): BudgetedDynamicRawResult {
    let clampedToRMin = false;
    let clampedToRMax = false;

    // Compute min/max target bounds based on rate clamps
    const minTargetMicros =
        (theirNotionalMicros * BigInt(rMinBps)) / BigInt(10000);
    const maxTargetMicros =
        (theirNotionalMicros * BigInt(rMaxBps)) / BigInt(10000);

    let rawTargetMicros: bigint;

    if (leaderExposureMicros <= BigInt(0)) {
        // No exposure data: use rMax (bounded behavior)
        rawTargetMicros = maxTargetMicros;
        clampedToRMax = true;
        logger.debug(
            { leaderExposure: "0", rMaxBps },
            "Leader exposure is 0, using rMax for budgeted dynamic"
        );
    } else {
        // raw = floor(theirNotional * budget / leaderExposure)
        rawTargetMicros =
            (theirNotionalMicros * budgetUsdcMicros) / leaderExposureMicros;

        // Clamp by rate bounds
        if (rawTargetMicros < minTargetMicros) {
            rawTargetMicros = minTargetMicros;
            clampedToRMin = true;
        } else if (rawTargetMicros > maxTargetMicros) {
            rawTargetMicros = maxTargetMicros;
            clampedToRMax = true;
        }
    }

    // Compute effective rate for observability (as bps, integer)
    // effectiveRate = (rawTarget / theirNotional) * 10000
    let effectiveRateBps = 0;
    if (theirNotionalMicros > BigInt(0)) {
        effectiveRateBps = Number(
            (rawTargetMicros * BigInt(10000)) / theirNotionalMicros
        );
    }

    return {
        rawTargetMicros,
        effectiveRateBps,
        clampedToRMin,
        clampedToRMax,
    };
}

/**
 * Apply trade-level sizing clamps to a raw target notional.
 *
 * Clamps:
 * 1. min/max trade notional bounds
 * 2. bankroll percentage limit
 *
 * @param rawTargetMicros - Raw target notional before clamps
 * @param bankrollEquityMicros - Current portfolio equity in micros
 * @param sizing - Sizing configuration
 */
export function applyTradeSizingClamps(
    rawTargetMicros: bigint,
    bankrollEquityMicros: bigint,
    sizing: Sizing
): TargetNotionalResult {
    let targetMicros = rawTargetMicros;
    let clampedToMin = false;
    let clampedToMax = false;
    let clampedByBankroll = false;

    // Clamp to minimum
    const minMicros = BigInt(sizing.minTradeNotionalMicros);
    if (targetMicros < minMicros) {
        targetMicros = minMicros;
        clampedToMin = true;
    }

    // Clamp to maximum
    const maxMicros = BigInt(sizing.maxTradeNotionalMicros);
    if (targetMicros > maxMicros) {
        targetMicros = maxMicros;
        clampedToMax = true;
    }

    // Clamp by bankroll percentage
    // maxTradeBankrollBps is in basis points (75 = 0.75%)
    const bankrollMaxMicros =
        (bankrollEquityMicros * BigInt(sizing.maxTradeBankrollBps)) / BigInt(10000);

    if (targetMicros > bankrollMaxMicros && bankrollMaxMicros > BigInt(0)) {
        targetMicros = bankrollMaxMicros;
        clampedByBankroll = true;
        // If bankroll clamp puts us below min, use min
        if (targetMicros < minMicros) {
            targetMicros = minMicros;
            clampedToMin = true;
            clampedByBankroll = false;
        }
    }

    return {
        targetNotionalMicros: targetMicros,
        rawTargetMicros,
        clampedToMin,
        clampedToMax,
        clampedByBankroll,
    };
}

/**
 * Compute raw target notional based on sizing mode.
 *
 * - If budgetedDynamicEnabled=false OR sizingMode="fixedRate": use fixed-rate formula
 * - If budgetedDynamicEnabled=true AND sizingMode="budgetedDynamic": use budget/exposure formula
 *
 * @param theirNotionalMicros - The followed user's trade notional in micros
 * @param sizing - Sizing configuration
 * @param leaderExposureMicros - Leader's exposure (required for budgeted dynamic mode)
 */
export function computeRawTargetNotional(
    theirNotionalMicros: bigint,
    sizing: Sizing,
    leaderExposureMicros?: bigint
): { rawTargetMicros: bigint; effectiveRateBps?: number; clampedToRMin?: boolean; clampedToRMax?: boolean } {
    const useBudgetedDynamic =
        sizing.budgetedDynamicEnabled &&
        sizing.sizingMode === SizingMode.BUDGETED_DYNAMIC;

    if (useBudgetedDynamic) {
        const result = computeBudgetedDynamicRawTargetMicros(
            theirNotionalMicros,
            BigInt(sizing.budgetUsdcMicros),
            leaderExposureMicros ?? BigInt(0),
            sizing.budgetRMinBps,
            sizing.budgetRMaxBps
        );
        return {
            rawTargetMicros: result.rawTargetMicros,
            effectiveRateBps: result.effectiveRateBps,
            clampedToRMin: result.clampedToRMin,
            clampedToRMax: result.clampedToRMax,
        };
    }

    // Fixed-rate formula: their_notional * copy_pct_bps / 10000
    const rawTargetMicros =
        (theirNotionalMicros * BigInt(sizing.copyPctNotionalBps)) / BigInt(10000);

    return { rawTargetMicros };
}

/**
 * Compute target notional for a copy trade (fixed-rate mode).
 *
 * Formula:
 *   target = floor(their_notional * copy_pct)
 *   target = clamp(target, min, max)
 *   target = min(target, bankroll * bankroll_pct)
 *
 * Note: This function always uses fixed-rate sizing. For mode-aware sizing,
 * use computeRawTargetNotional() + applyTradeSizingClamps() instead.
 *
 * @param theirNotionalMicros - The followed user's group notional in micros
 * @param bankrollEquityMicros - Current portfolio equity in micros
 * @param sizing - Sizing configuration
 */
export function computeTargetNotional(
    theirNotionalMicros: bigint,
    bankrollEquityMicros: bigint,
    sizing: Sizing
): TargetNotionalResult {
    // Compute raw target using fixed-rate formula
    const rawTargetMicros =
        (theirNotionalMicros * BigInt(sizing.copyPctNotionalBps)) / BigInt(10000);

    // Apply trade-level clamps
    const result = applyTradeSizingClamps(rawTargetMicros, bankrollEquityMicros, sizing);

    logger.debug(
        {
            theirNotional: theirNotionalMicros.toString(),
            rawTarget: rawTargetMicros.toString(),
            finalTarget: result.targetNotionalMicros.toString(),
            clampedToMin: result.clampedToMin,
            clampedToMax: result.clampedToMax,
            clampedByBankroll: result.clampedByBankroll,
        },
        "Computed target notional (fixed-rate)"
    );

    return result;
}

/**
 * Compute target shares from target notional and price.
 *
 * @param targetNotionalMicros - Target notional in micros
 * @param priceMicros - Price in micros (0..1_000_000)
 * @returns Target shares in micros
 */
export function computeTargetShares(
    targetNotionalMicros: bigint,
    priceMicros: number
): bigint {
    if (priceMicros <= 0) {
        return BigInt(0);
    }

    // shares = notional / price
    // shares_micros = (notional_micros * 1_000_000) / price_micros
    return (targetNotionalMicros * BigInt(1_000_000)) / BigInt(priceMicros);
}

/**
 * Compute notional from shares and price.
 *
 * @param shareMicros - Shares in micros
 * @param priceMicros - Price in micros (0..1_000_000)
 * @returns Notional in micros
 */
export function computeNotional(shareMicros: bigint, priceMicros: number): bigint {
    // notional = shares * price
    // notional_micros = (shares_micros * price_micros) / 1_000_000
    return (shareMicros * BigInt(priceMicros)) / BigInt(1_000_000);
}
