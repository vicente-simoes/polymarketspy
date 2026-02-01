import { describe, it, expect } from "vitest";
import { computeEquityAndPnlMicros, getBucketMs, isWithinBoundaryWindow } from "./equityMath.js";

describe("computeEquityAndPnlMicros", () => {
    it("computes equity and pnl with initial bankroll, deposits, and marked positions", () => {
        const priceByAsset = new Map<string, number>([
            ["a1", 600_000], // $0.60
            ["a2", 250_000], // $0.25
        ]);

        const result = computeEquityAndPnlMicros({
            initialBankrollMicros: 100_000_000n, // $100
            stateCashMicros: 50_000_000n, // +$50 deposit net (ledger-derived)
            stateContributedCapitalMicros: 50_000_000n, // +$50 contributed
            positions: [
                { assetId: "a1", shareMicros: 10_000_000n }, // 10 shares
                { assetId: "a2", shareMicros: 20_000_000n }, // 20 shares
            ],
            priceByAsset,
            defaultMarkPriceMicros: 500_000,
        });

        // cash = 100 + 50 = 150
        // pos value = 10*0.60 + 20*0.25 = 6 + 5 = 11
        // equity = 161
        // contributed = 100 + 50 = 150
        // pnl = 11
        expect(result.totalPositionValueMicros).toBe(11_000_000n);
        expect(result.equityMicros).toBe(161_000_000n);
        expect(result.contributedCapitalMicros).toBe(150_000_000n);
        expect(result.pnlMicros).toBe(11_000_000n);
    });

    it("uses a default mark price when the asset price is missing", () => {
        const priceByAsset = new Map<string, number>([]);
        const result = computeEquityAndPnlMicros({
            initialBankrollMicros: 0n,
            stateCashMicros: 0n,
            stateContributedCapitalMicros: 0n,
            positions: [{ assetId: "missing", shareMicros: 2_000_000n }], // 2 shares
            priceByAsset,
            defaultMarkPriceMicros: 500_000, // $0.50
        });

        // 2 * 0.50 = $1.00
        expect(result.totalPositionValueMicros).toBe(1_000_000n);
        expect(result.equityMicros).toBe(1_000_000n);
        expect(result.pnlMicros).toBe(1_000_000n);
    });
});

describe("bucket helpers", () => {
    it("computes bucket boundaries deterministically", () => {
        const intervalMs = 20 * 60_000;
        const t = Date.parse("2026-01-31T12:34:56.789Z");
        const bucket = getBucketMs(t, intervalMs);
        expect(new Date(bucket).toISOString()).toBe("2026-01-31T12:20:00.000Z");
    });

    it("detects whether we are within the boundary window", () => {
        const intervalMs = 20 * 60_000;
        const boundaryWindowMs = 5 * 60_000;
        const bucketStart = Date.parse("2026-01-31T12:20:00.000Z");

        expect(isWithinBoundaryWindow(bucketStart + 60_000, intervalMs, boundaryWindowMs)).toBe(true);
        expect(isWithinBoundaryWindow(bucketStart + 6 * 60_000, intervalMs, boundaryWindowMs)).toBe(false);
    });
});

