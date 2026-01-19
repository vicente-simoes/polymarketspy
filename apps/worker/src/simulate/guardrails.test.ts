/**
 * Unit tests for guardrails and price bounds computation.
 *
 * Tests the fix for the "always skip" bug where midPriceMicros=0
 * was causing BUY orders to have impossibly low maxPriceMicros.
 */

import { describe, it, expect } from "vitest";
import { TradeSide } from "@prisma/client";
import { computePriceBounds, checkSpreadFilter, checkDepthRequirement } from "./guardrails.js";
import { DEFAULT_GUARDRAILS } from "./config.js";

describe("computePriceBounds", () => {
    describe("BUY side", () => {
        it("should compute correct max price with realistic mid (the bug fix)", () => {
            // This is the test case from the fix plan:
            // Given theirRef=600000 and mid=600000, max BUY price should be
            // min(610000, 615000) = 610000 (with current defaults)
            const bounds = computePriceBounds(
                TradeSide.BUY,
                600_000, // theirRefPriceMicros = $0.60
                600_000, // midPriceMicros = $0.60
                DEFAULT_GUARDRAILS
            );

            // maxVsTheirFill = 600000 + 10000 = 610000
            // maxVsMid = 600000 + 15000 = 615000
            // maxPriceMicros = min(610000, 615000) = 610000
            expect(bounds.maxPriceMicros).toBe(610_000);
            expect(bounds.minPriceMicros).toBeUndefined();
        });

        it("should compute impossibly low max price when mid=0 (the bug)", () => {
            // This demonstrates the bug: when mid=0, max price becomes ~15000
            // which is why all BUYs were being skipped
            const bounds = computePriceBounds(
                TradeSide.BUY,
                600_000, // theirRefPriceMicros = $0.60
                0, // midPriceMicros = $0 (the bug!)
                DEFAULT_GUARDRAILS
            );

            // maxVsTheirFill = 600000 + 10000 = 610000
            // maxVsMid = 0 + 15000 = 15000
            // maxPriceMicros = min(610000, 15000) = 15000 <- BUG!
            expect(bounds.maxPriceMicros).toBe(15_000);
        });

        it("should compute correct bounds for low-priced market", () => {
            const bounds = computePriceBounds(
                TradeSide.BUY,
                50_000, // theirRefPriceMicros = $0.05
                50_000, // midPriceMicros = $0.05
                DEFAULT_GUARDRAILS
            );

            // maxVsTheirFill = 50000 + 10000 = 60000
            // maxVsMid = 50000 + 15000 = 65000
            // maxPriceMicros = min(60000, 65000) = 60000
            expect(bounds.maxPriceMicros).toBe(60_000);
        });

        it("should compute correct bounds for high-priced market", () => {
            const bounds = computePriceBounds(
                TradeSide.BUY,
                900_000, // theirRefPriceMicros = $0.90
                900_000, // midPriceMicros = $0.90
                DEFAULT_GUARDRAILS
            );

            // maxVsTheirFill = 900000 + 10000 = 910000
            // maxVsMid = 900000 + 15000 = 915000
            // maxPriceMicros = min(910000, 915000) = 910000
            expect(bounds.maxPriceMicros).toBe(910_000);
        });

        it("should use theirRef limit when mid is higher", () => {
            const bounds = computePriceBounds(
                TradeSide.BUY,
                500_000, // theirRefPriceMicros = $0.50
                520_000, // midPriceMicros = $0.52 (higher than their ref)
                DEFAULT_GUARDRAILS
            );

            // maxVsTheirFill = 500000 + 10000 = 510000 <- limiting factor
            // maxVsMid = 520000 + 15000 = 535000
            // maxPriceMicros = min(510000, 535000) = 510000
            expect(bounds.maxPriceMicros).toBe(510_000);
        });

        it("should use mid limit when theirRef is higher", () => {
            const bounds = computePriceBounds(
                TradeSide.BUY,
                530_000, // theirRefPriceMicros = $0.53 (higher)
                500_000, // midPriceMicros = $0.50
                DEFAULT_GUARDRAILS
            );

            // maxVsTheirFill = 530000 + 10000 = 540000
            // maxVsMid = 500000 + 15000 = 515000 <- limiting factor
            // maxPriceMicros = min(540000, 515000) = 515000
            expect(bounds.maxPriceMicros).toBe(515_000);
        });
    });

    describe("SELL side", () => {
        it("should compute correct min price with realistic mid", () => {
            const bounds = computePriceBounds(
                TradeSide.SELL,
                600_000, // theirRefPriceMicros = $0.60
                600_000, // midPriceMicros = $0.60
                DEFAULT_GUARDRAILS
            );

            // minVsTheirFill = 600000 - 10000 = 590000
            // minVsMid = 600000 - 15000 = 585000
            // minPriceMicros = max(590000, 585000) = 590000
            expect(bounds.minPriceMicros).toBe(590_000);
            expect(bounds.maxPriceMicros).toBeUndefined();
        });

        it("should compute negative min price when mid=0 (the bug on SELL side)", () => {
            const bounds = computePriceBounds(
                TradeSide.SELL,
                600_000, // theirRefPriceMicros = $0.60
                0, // midPriceMicros = $0 (the bug!)
                DEFAULT_GUARDRAILS
            );

            // minVsTheirFill = 600000 - 10000 = 590000
            // minVsMid = 0 - 15000 = -15000
            // minPriceMicros = max(590000, -15000) = 590000
            // Note: For SELL, the bug is less impactful because max() is used
            expect(bounds.minPriceMicros).toBe(590_000);
        });
    });
});

describe("checkSpreadFilter", () => {
    it("should pass when spread is within limit", () => {
        const result = checkSpreadFilter(10_000, DEFAULT_GUARDRAILS); // 1 cent spread
        expect(result.passed).toBe(true);
        expect(result.reasonCodes).toHaveLength(0);
    });

    it("should fail when spread exceeds limit", () => {
        const result = checkSpreadFilter(30_000, DEFAULT_GUARDRAILS); // 3 cent spread > 2 cent limit
        expect(result.passed).toBe(false);
        expect(result.reasonCodes).toContain("SPREAD_TOO_WIDE");
    });

    it("should pass at exactly the limit", () => {
        const result = checkSpreadFilter(20_000, DEFAULT_GUARDRAILS); // exactly 2 cent limit
        expect(result.passed).toBe(true);
    });
});

describe("checkDepthRequirement", () => {
    it("should pass when depth exceeds requirement", () => {
        const result = checkDepthRequirement(
            BigInt(200_000_000), // 200 USDC available
            BigInt(100_000_000), // 100 USDC target
            DEFAULT_GUARDRAILS // 1.25x multiplier
        );
        // Required = 100 * 1.25 = 125 USDC, available = 200 USDC -> pass
        expect(result.passed).toBe(true);
        expect(result.reasonCodes).toHaveLength(0);
    });

    it("should fail when depth is insufficient", () => {
        const result = checkDepthRequirement(
            BigInt(100_000_000), // 100 USDC available
            BigInt(100_000_000), // 100 USDC target
            DEFAULT_GUARDRAILS // 1.25x multiplier
        );
        // Required = 100 * 1.25 = 125 USDC, available = 100 USDC -> fail
        expect(result.passed).toBe(false);
        expect(result.reasonCodes).toContain("INSUFFICIENT_DEPTH");
    });

    it("should pass at exactly the requirement", () => {
        const result = checkDepthRequirement(
            BigInt(125_000_000), // 125 USDC available (exactly 1.25x of target)
            BigInt(100_000_000), // 100 USDC target
            DEFAULT_GUARDRAILS
        );
        expect(result.passed).toBe(true);
    });
});
