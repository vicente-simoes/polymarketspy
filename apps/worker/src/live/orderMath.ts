import { TradeSide } from "@prisma/client";
import { ReasonCodes, type ReasonCode } from "@copybot/shared";

const MICROS_PER_UNIT = 1_000_000n;

/**
 * Floor price to tick (conservative for BUY: pay less).
 */
export function floorToTick(priceMicros: number, tickSizeMicros: number): number {
    if (!Number.isFinite(priceMicros) || !Number.isFinite(tickSizeMicros) || tickSizeMicros <= 0) {
        return priceMicros;
    }
    return Math.floor(priceMicros / tickSizeMicros) * tickSizeMicros;
}

/**
 * Ceil price to tick (conservative for SELL: receive more).
 */
export function ceilToTick(priceMicros: number, tickSizeMicros: number): number {
    if (!Number.isFinite(priceMicros) || !Number.isFinite(tickSizeMicros) || tickSizeMicros <= 0) {
        return priceMicros;
    }
    return Math.ceil(priceMicros / tickSizeMicros) * tickSizeMicros;
}

/**
 * Floor size to step (both sides).
 */
export function floorToStep(shareMicros: bigint, stepMicros: bigint): bigint {
    if (stepMicros <= 0n) return shareMicros;
    return (shareMicros / stepMicros) * stepMicros;
}

export type MarketabilityResult = { ok: true } | { ok: false; reasonCode: ReasonCode };

/**
 * Post-rounding marketability check.
 * - BUY must be >= bestAsk
 * - SELL must be <= bestBid
 */
export function checkPostTickRoundingMarketability(args: {
    side: TradeSide;
    roundedPriceMicros: number;
    bestBidMicros: number;
    bestAskMicros: number;
}): MarketabilityResult {
    if (args.side === TradeSide.BUY && args.roundedPriceMicros < args.bestAskMicros) {
        return { ok: false, reasonCode: ReasonCodes.LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING };
    }

    if (args.side === TradeSide.SELL && args.roundedPriceMicros > args.bestBidMicros) {
        return { ok: false, reasonCode: ReasonCodes.LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING };
    }

    return { ok: true };
}

export type ShrinkSharesResult =
    | { ok: true; shareMicros: bigint; wasShrunk: boolean }
    | { ok: false; reasonCode: ReasonCode };

/**
 * BUY shrink-to-affordable logic.
 *
 * If required cash exceeds available, shrink to floor(available/price) and floor to step.
 */
export function shrinkBuySharesToAffordable(args: {
    targetShareMicros: bigint;
    priceMicros: number;
    availableCashMicros: bigint;
    sizeStepShareMicros: bigint;
    minOrderSizeShareMicros: bigint;
}): ShrinkSharesResult {
    const priceMicros = BigInt(Math.max(0, Math.trunc(args.priceMicros)));
    if (priceMicros === 0n) {
        return { ok: false, reasonCode: ReasonCodes.LIVE_INVALID_TICK_OR_STEP };
    }

    const requiredCashMicros = (priceMicros * args.targetShareMicros) / MICROS_PER_UNIT;
    if (requiredCashMicros <= args.availableCashMicros) {
        return { ok: true, shareMicros: args.targetShareMicros, wasShrunk: false };
    }

    const affordableShareMicros = (args.availableCashMicros * MICROS_PER_UNIT) / priceMicros;
    const roundedAffordable = floorToStep(affordableShareMicros, args.sizeStepShareMicros);

    if (roundedAffordable < args.minOrderSizeShareMicros) {
        return { ok: false, reasonCode: ReasonCodes.LIVE_INSUFFICIENT_CASH_TO_BUY };
    }

    return { ok: true, shareMicros: roundedAffordable, wasShrunk: true };
}

/**
 * SELL shrink-to-available logic.
 *
 * If requested shares exceed available, shrink to floor(available) and floor to step.
 */
export function shrinkSellSharesToAvailable(args: {
    targetShareMicros: bigint;
    availableShareMicros: bigint;
    sizeStepShareMicros: bigint;
    minOrderSizeShareMicros: bigint;
}): ShrinkSharesResult {
    if (args.targetShareMicros <= args.availableShareMicros) {
        return { ok: true, shareMicros: args.targetShareMicros, wasShrunk: false };
    }

    const roundedAvailable = floorToStep(args.availableShareMicros, args.sizeStepShareMicros);
    if (roundedAvailable < args.minOrderSizeShareMicros) {
        return { ok: false, reasonCode: ReasonCodes.LIVE_INSUFFICIENT_POSITION_TO_SELL };
    }

    return { ok: true, shareMicros: roundedAvailable, wasShrunk: true };
}

