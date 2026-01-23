/**
 * Unit tests for budgeted dynamic sizing.
 *
 * Tests the core sizing math for:
 * - computeBudgetedDynamicRawTargetMicros
 * - applyTradeSizingClamps
 * - computeRawTargetNotional
 */

import { describe, it, expect } from "vitest";
import {
    computeBudgetedDynamicRawTargetMicros,
    applyTradeSizingClamps,
    computeRawTargetNotional,
} from "./sizing.js";
import { DEFAULT_SIZING } from "./config.js";
import type { Sizing } from "@copybot/shared";

describe("computeBudgetedDynamicRawTargetMicros", () => {
    describe("zero leader exposure", () => {
        it("should use rMax rate when leader exposure is 0", () => {
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(100_000_000), // their notional = $100
                BigInt(40_000_000), // budget = $40
                BigInt(0), // leader exposure = $0
                0, // rMin = 0%
                100 // rMax = 1%
            );

            // When exposure = 0, use rMax rate
            // rawTarget = theirNotional * rMaxBps / 10000 = 100_000_000 * 100 / 10000 = 1_000_000
            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.clampedToRMax).toBe(true);
            expect(result.clampedToRMin).toBe(false);
            expect(result.effectiveRateBps).toBe(100); // 1%
        });

        it("should use rMax rate when leader exposure is negative", () => {
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(100_000_000), // their notional = $100
                BigInt(40_000_000), // budget = $40
                BigInt(-1_000_000), // leader exposure = -$1 (edge case)
                0, // rMin = 0%
                100 // rMax = 1%
            );

            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.clampedToRMax).toBe(true);
        });
    });

    describe("normal case computation", () => {
        it("should compute correct raw target with normal inputs", () => {
            // Budget = $40, Leader Exposure = $4000
            // Effective rate = 40 / 4000 = 0.01 = 1%
            // Their trade = $100, so raw target = $100 * 0.01 = $1
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(100_000_000), // their notional = $100
                BigInt(40_000_000), // budget = $40
                BigInt(4_000_000_000), // leader exposure = $4000
                0, // rMin = 0%
                200 // rMax = 2%
            );

            // raw = floor(100_000_000 * 40_000_000 / 4_000_000_000) = floor(1_000_000) = 1_000_000
            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.effectiveRateBps).toBe(100); // 1%
            expect(result.clampedToRMin).toBe(false);
            expect(result.clampedToRMax).toBe(false);
        });

        it("should floor the result for fractional values", () => {
            // Budget = $33, Leader Exposure = $1000
            // Effective rate = 33 / 1000 = 0.033 = 3.3%
            // Their trade = $100, so raw target = $100 * 0.033 = $3.30
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(100_000_000), // their notional = $100
                BigInt(33_000_000), // budget = $33
                BigInt(1_000_000_000), // leader exposure = $1000
                0, // rMin = 0%
                500 // rMax = 5%
            );

            // raw = floor(100_000_000 * 33_000_000 / 1_000_000_000) = floor(3_300_000) = 3_300_000
            expect(result.rawTargetMicros).toBe(BigInt(3_300_000));
            expect(result.effectiveRateBps).toBe(330); // 3.3%
        });
    });

    describe("rate clamping", () => {
        it("should clamp to rMin when computed rate is too low", () => {
            // Budget = $10, Leader Exposure = $100000 -> rate = 0.0001 = 0.01%
            // rMin = 0.5%, so should clamp up
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(100_000_000), // their notional = $100
                BigInt(10_000_000), // budget = $10
                BigInt(100_000_000_000), // leader exposure = $100000
                50, // rMin = 0.5%
                200 // rMax = 2%
            );

            // Unclamped: raw = floor(100_000_000 * 10_000_000 / 100_000_000_000) = 10_000 ($0.01)
            // rMin target = 100_000_000 * 50 / 10000 = 500_000 ($0.50)
            // Clamped to rMin
            expect(result.rawTargetMicros).toBe(BigInt(500_000));
            expect(result.clampedToRMin).toBe(true);
            expect(result.clampedToRMax).toBe(false);
            expect(result.effectiveRateBps).toBe(50); // 0.5% (clamped)
        });

        it("should clamp to rMax when computed rate is too high", () => {
            // Budget = $500, Leader Exposure = $1000 -> rate = 0.5 = 50%
            // rMax = 2%, so should clamp down
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(100_000_000), // their notional = $100
                BigInt(500_000_000), // budget = $500
                BigInt(1_000_000_000), // leader exposure = $1000
                0, // rMin = 0%
                200 // rMax = 2%
            );

            // Unclamped: raw = floor(100_000_000 * 500_000_000 / 1_000_000_000) = 50_000_000 ($50)
            // rMax target = 100_000_000 * 200 / 10000 = 2_000_000 ($2)
            // Clamped to rMax
            expect(result.rawTargetMicros).toBe(BigInt(2_000_000));
            expect(result.clampedToRMax).toBe(true);
            expect(result.clampedToRMin).toBe(false);
            expect(result.effectiveRateBps).toBe(200); // 2% (clamped)
        });

        it("should not clamp when rate is within bounds", () => {
            // Budget = $40, Leader Exposure = $4000 -> rate = 1%
            // rMin = 0.5%, rMax = 2%, so 1% is within bounds
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(100_000_000), // their notional = $100
                BigInt(40_000_000), // budget = $40
                BigInt(4_000_000_000), // leader exposure = $4000
                50, // rMin = 0.5%
                200 // rMax = 2%
            );

            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.clampedToRMin).toBe(false);
            expect(result.clampedToRMax).toBe(false);
            expect(result.effectiveRateBps).toBe(100); // 1%
        });
    });

    describe("effectiveRateBps computation", () => {
        it("should return correct effectiveRateBps", () => {
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(200_000_000), // their notional = $200
                BigInt(30_000_000), // budget = $30
                BigInt(2_000_000_000), // leader exposure = $2000
                0, // rMin = 0%
                500 // rMax = 5%
            );

            // rate = 30 / 2000 = 0.015 = 1.5%
            // raw = 200_000_000 * 30_000_000 / 2_000_000_000 = 3_000_000 ($3)
            expect(result.effectiveRateBps).toBe(150); // 1.5%
        });

        it("should handle zero their notional for effectiveRateBps", () => {
            const result = computeBudgetedDynamicRawTargetMicros(
                BigInt(0), // their notional = $0
                BigInt(40_000_000), // budget = $40
                BigInt(4_000_000_000), // leader exposure = $4000
                0, // rMin = 0%
                200 // rMax = 2%
            );

            // raw = 0 * anything = 0
            // effectiveRateBps should be 0 (can't compute rate from 0)
            expect(result.rawTargetMicros).toBe(BigInt(0));
            expect(result.effectiveRateBps).toBe(0);
        });
    });
});

describe("applyTradeSizingClamps", () => {
    const baseSizing: Sizing = {
        ...DEFAULT_SIZING,
        minTradeNotionalMicros: 5_000_000, // $5
        maxTradeNotionalMicros: 250_000_000, // $250
        maxTradeBankrollBps: 75, // 0.75%
    };

    describe("min/max notional clamps", () => {
        it("should clamp to minimum when target is too low", () => {
            const result = applyTradeSizingClamps(
                BigInt(1_000_000), // $1 raw target (below $5 min)
                BigInt(10_000_000_000), // $10000 bankroll
                baseSizing
            );

            expect(result.targetNotionalMicros).toBe(BigInt(5_000_000)); // $5
            expect(result.clampedToMin).toBe(true);
            expect(result.clampedToMax).toBe(false);
            expect(result.clampedByBankroll).toBe(false);
        });

        it("should clamp to maximum when target is too high", () => {
            const result = applyTradeSizingClamps(
                BigInt(500_000_000), // $500 raw target (above $250 max)
                BigInt(100_000_000_000), // $100000 bankroll (high enough to not trigger bankroll clamp)
                baseSizing
            );

            expect(result.targetNotionalMicros).toBe(BigInt(250_000_000)); // $250
            expect(result.clampedToMax).toBe(true);
            expect(result.clampedToMin).toBe(false);
        });

        it("should not clamp when target is within bounds", () => {
            const result = applyTradeSizingClamps(
                BigInt(50_000_000), // $50 raw target (within bounds)
                BigInt(10_000_000_000), // $10000 bankroll
                baseSizing
            );

            expect(result.targetNotionalMicros).toBe(BigInt(50_000_000)); // $50
            expect(result.clampedToMin).toBe(false);
            expect(result.clampedToMax).toBe(false);
            expect(result.clampedByBankroll).toBe(false);
        });
    });

    describe("bankroll percentage clamp", () => {
        it("should clamp by bankroll when target exceeds percentage", () => {
            // Bankroll = $1000, maxTradeBankrollBps = 75 (0.75%)
            // Max from bankroll = $1000 * 0.0075 = $7.50
            const result = applyTradeSizingClamps(
                BigInt(50_000_000), // $50 raw target
                BigInt(1_000_000_000), // $1000 bankroll
                baseSizing
            );

            // $50 > $7.50, so clamp to $7.50
            expect(result.targetNotionalMicros).toBe(BigInt(7_500_000)); // $7.50
            expect(result.clampedByBankroll).toBe(true);
        });

        it("should use min when bankroll clamp puts target below min", () => {
            // Bankroll = $100, maxTradeBankrollBps = 75 (0.75%)
            // Max from bankroll = $100 * 0.0075 = $0.75 (below $5 min)
            const result = applyTradeSizingClamps(
                BigInt(50_000_000), // $50 raw target
                BigInt(100_000_000), // $100 bankroll
                baseSizing
            );

            // Bankroll clamp = $0.75 < $5 min, so use min
            expect(result.targetNotionalMicros).toBe(BigInt(5_000_000)); // $5
            expect(result.clampedToMin).toBe(true);
            expect(result.clampedByBankroll).toBe(false); // min took precedence
        });
    });

    describe("rawTargetMicros preservation", () => {
        it("should preserve raw target in result", () => {
            const rawTarget = BigInt(1_000_000); // $1 (will be clamped to min)
            const result = applyTradeSizingClamps(
                rawTarget,
                BigInt(10_000_000_000),
                baseSizing
            );

            expect(result.rawTargetMicros).toBe(rawTarget);
            expect(result.targetNotionalMicros).toBe(BigInt(5_000_000)); // clamped
        });
    });
});

describe("computeRawTargetNotional", () => {
    describe("fixed-rate mode", () => {
        it("should use fixed-rate formula when sizingMode is fixedRate", () => {
            const sizing: Sizing = {
                ...DEFAULT_SIZING,
                sizingMode: "fixedRate",
                budgetedDynamicEnabled: true, // even if enabled, mode wins
                copyPctNotionalBps: 100, // 1%
            };

            const result = computeRawTargetNotional(
                BigInt(100_000_000), // their notional = $100
                sizing,
                BigInt(4_000_000_000) // leader exposure (ignored in fixed-rate)
            );

            // raw = 100_000_000 * 100 / 10000 = 1_000_000 ($1)
            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.effectiveRateBps).toBeUndefined();
        });

        it("should use fixed-rate formula when budgetedDynamicEnabled is false", () => {
            const sizing: Sizing = {
                ...DEFAULT_SIZING,
                sizingMode: "budgetedDynamic",
                budgetedDynamicEnabled: false, // disabled takes precedence
                copyPctNotionalBps: 100, // 1%
            };

            const result = computeRawTargetNotional(
                BigInt(100_000_000), // their notional = $100
                sizing,
                BigInt(4_000_000_000)
            );

            // Falls back to fixed-rate
            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.effectiveRateBps).toBeUndefined();
        });
    });

    describe("budgeted dynamic mode", () => {
        it("should use dynamic formula when enabled and mode is budgetedDynamic", () => {
            const sizing: Sizing = {
                ...DEFAULT_SIZING,
                sizingMode: "budgetedDynamic",
                budgetedDynamicEnabled: true,
                budgetUsdcMicros: 40_000_000, // $40 budget
                budgetRMinBps: 0,
                budgetRMaxBps: 200, // 2%
            };

            const result = computeRawTargetNotional(
                BigInt(100_000_000), // their notional = $100
                sizing,
                BigInt(4_000_000_000) // leader exposure = $4000
            );

            // rate = 40 / 4000 = 0.01 = 1%
            // raw = 100_000_000 * 0.01 = 1_000_000 ($1)
            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.effectiveRateBps).toBe(100); // 1%
        });

        it("should handle missing leader exposure in dynamic mode", () => {
            const sizing: Sizing = {
                ...DEFAULT_SIZING,
                sizingMode: "budgetedDynamic",
                budgetedDynamicEnabled: true,
                budgetUsdcMicros: 40_000_000, // $40 budget
                budgetRMinBps: 0,
                budgetRMaxBps: 100, // 1%
            };

            const result = computeRawTargetNotional(
                BigInt(100_000_000), // their notional = $100
                sizing
                // no leader exposure provided -> defaults to 0
            );

            // When exposure = 0 or undefined, uses rMax
            // raw = 100_000_000 * 100 / 10000 = 1_000_000 ($1)
            expect(result.rawTargetMicros).toBe(BigInt(1_000_000));
            expect(result.clampedToRMax).toBe(true);
        });
    });
});
