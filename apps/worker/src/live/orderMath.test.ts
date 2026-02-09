import { describe, it, expect } from "vitest";
import { TradeSide } from "@prisma/client";
import { ReasonCodes } from "@copybot/shared";
import {
    ceilToTick,
    checkPostTickRoundingMarketability,
    floorToStep,
    floorToTick,
    shrinkBuySharesToAffordable,
    shrinkSellSharesToAvailable,
} from "./orderMath.js";

describe("tick/step rounding", () => {
    it("floors and ceils to tick", () => {
        expect(floorToTick(105_000, 10_000)).toBe(100_000);
        expect(ceilToTick(101_000, 10_000)).toBe(110_000);
    });

    it("floors to step", () => {
        expect(floorToStep(10_123n, 10n)).toBe(10_120n);
        expect(floorToStep(10_123n, 1n)).toBe(10_123n);
    });
});

describe("post-rounding marketability", () => {
    it("flags BUY as not marketable when rounded price < bestAsk", () => {
        const roundedPriceMicros = floorToTick(101_000, 10_000); // 100_000
        const result = checkPostTickRoundingMarketability({
            side: TradeSide.BUY,
            roundedPriceMicros,
            bestBidMicros: 99_000,
            bestAskMicros: 101_000,
        });
        expect(result).toEqual({
            ok: false,
            reasonCode: ReasonCodes.LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING,
        });
    });

    it("flags SELL as not marketable when rounded price > bestBid", () => {
        const roundedPriceMicros = ceilToTick(99_000, 10_000); // 100_000
        const result = checkPostTickRoundingMarketability({
            side: TradeSide.SELL,
            roundedPriceMicros,
            bestBidMicros: 99_000,
            bestAskMicros: 101_000,
        });
        expect(result).toEqual({
            ok: false,
            reasonCode: ReasonCodes.LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING,
        });
    });

    it("accepts marketable prices", () => {
        expect(
            checkPostTickRoundingMarketability({
                side: TradeSide.BUY,
                roundedPriceMicros: 101_000,
                bestBidMicros: 99_000,
                bestAskMicros: 101_000,
            })
        ).toEqual({ ok: true });
    });
});

describe("inventory shrink-to-fit", () => {
    it("shrinks BUY to affordable shares", () => {
        const result = shrinkBuySharesToAffordable({
            targetShareMicros: 10_000_000n, // 10 shares
            priceMicros: 500_000, // $0.50
            availableCashMicros: 4_000_000n, // $4
            sizeStepShareMicros: 1n,
            minOrderSizeShareMicros: 1_000_000n, // 1 share
        });

        expect(result).toEqual({ ok: true, shareMicros: 8_000_000n, wasShrunk: true });
    });

    it("fails BUY when affordable size is below exchange minimum", () => {
        const result = shrinkBuySharesToAffordable({
            targetShareMicros: 10_000_000n,
            priceMicros: 500_000,
            availableCashMicros: 400_000n, // $0.40 -> 0.8 shares
            sizeStepShareMicros: 1n,
            minOrderSizeShareMicros: 1_000_000n,
        });

        expect(result).toEqual({ ok: false, reasonCode: ReasonCodes.LIVE_INSUFFICIENT_CASH_TO_BUY });
    });

    it("shrinks SELL to available shares and floors to step", () => {
        const result = shrinkSellSharesToAvailable({
            targetShareMicros: 10_000_000n,
            availableShareMicros: 6_500_000n,
            sizeStepShareMicros: 1_000_000n, // 1 share step
            minOrderSizeShareMicros: 1_000_000n,
        });

        expect(result).toEqual({ ok: true, shareMicros: 6_000_000n, wasShrunk: true });
    });

    it("fails SELL when available size is below exchange minimum", () => {
        const result = shrinkSellSharesToAvailable({
            targetShareMicros: 2_000_000n,
            availableShareMicros: 500_000n,
            sizeStepShareMicros: 1n,
            minOrderSizeShareMicros: 1_000_000n,
        });

        expect(result).toEqual({
            ok: false,
            reasonCode: ReasonCodes.LIVE_INSUFFICIENT_POSITION_TO_SELL,
        });
    });
});

