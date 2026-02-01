import { describe, it, expect } from "vitest";
import { EquityPointGranularity } from "@prisma/client";
import { EQUITY_BOUNDARY_WINDOW_MS, EQUITY_GRANULARITIES, EQUITY_TICK_INTERVAL_MS } from "./equityPolicy.js";

describe("equity policy", () => {
    it("defines expected granularities and retention windows", () => {
        expect(EQUITY_TICK_INTERVAL_MS).toBe(60_000);
        expect(EQUITY_BOUNDARY_WINDOW_MS).toBe(5 * 60_000);

        const by = new Map(EQUITY_GRANULARITIES.map((g) => [g.granularity, g]));
        expect(by.get(EquityPointGranularity.M1)?.intervalMs).toBe(60_000);
        expect(by.get(EquityPointGranularity.M1)?.retentionMs).toBe(7 * 24 * 60 * 60 * 1000);

        expect(by.get(EquityPointGranularity.M20)?.intervalMs).toBe(20 * 60_000);
        expect(by.get(EquityPointGranularity.M20)?.retentionMs).toBe(90 * 24 * 60 * 60 * 1000);

        expect(by.get(EquityPointGranularity.H2)?.intervalMs).toBe(2 * 60 * 60_000);
        expect(by.get(EquityPointGranularity.H2)?.retentionMs).toBe(18 * 30 * 24 * 60 * 60 * 1000);

        expect(by.get(EquityPointGranularity.H12)?.intervalMs).toBe(12 * 60 * 60_000);
        expect(by.get(EquityPointGranularity.H12)?.retentionMs).toBe(5 * 365 * 24 * 60 * 60 * 1000);

        expect(by.get(EquityPointGranularity.D1)?.intervalMs).toBe(24 * 60 * 60_000);
        expect(by.get(EquityPointGranularity.D1)?.retentionMs).toBeNull();
    });
});

