/**
 * Trade sizing calculations for copy trading.
 *
 * Computes target notional based on:
 * - Their group notional * copy percentage (default 1%)
 * - Clamped to min/max bounds
 * - Further clamped by bankroll percentage
 */

import type { Sizing } from "@copybot/shared";
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
 * Compute target notional for a copy trade.
 *
 * Formula:
 *   target = floor(their_notional * copy_pct)
 *   target = clamp(target, min, max)
 *   target = min(target, bankroll * bankroll_pct)
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
    // Compute raw target: their_notional * copy_pct_bps / 10000
    // copyPctNotionalBps is in basis points (100 = 1%)
    const rawTargetMicros =
        (theirNotionalMicros * BigInt(sizing.copyPctNotionalBps)) / BigInt(10000);

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

    logger.debug(
        {
            theirNotional: theirNotionalMicros.toString(),
            rawTarget: rawTargetMicros.toString(),
            finalTarget: targetMicros.toString(),
            clampedToMin,
            clampedToMax,
            clampedByBankroll,
        },
        "Computed target notional"
    );

    return {
        targetNotionalMicros: targetMicros,
        rawTargetMicros,
        clampedToMin,
        clampedToMax,
        clampedByBankroll,
    };
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
