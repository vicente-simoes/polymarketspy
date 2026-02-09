import { describe, it, expect, afterEach } from "vitest";
import {
    applyFill,
    areSubmissionsPaused,
    getAvailableCash,
    getAvailableShares,
    getPauseReason,
    getStateSnapshot,
    initializeFromReconciliation,
    isStateHealthy,
    pauseSubmissions,
    releaseReservation,
    reserveCashForBuy,
    reserveSharesForSell,
    resetState,
    resumeSubmissions,
} from "./accountState.js";

afterEach(() => {
    resetState();
});

describe("reservations", () => {
    it("reserves and releases cash for BUY idempotently", () => {
        initializeFromReconciliation(100_000_000n, new Map());

        const r1 = reserveCashForBuy("t1", 500_000, 10_000_000n, "id-1");
        expect(r1.success).toBe(true);
        expect(getAvailableCash()).toBe(95_000_000n);
        expect(getStateSnapshot().reservedCashMicros).toBe(5_000_000n);

        const r2 = reserveCashForBuy("t1", 900_000, 99_000_000n, "id-1");
        expect(r2.success).toBe(true);
        expect(getAvailableCash()).toBe(95_000_000n);
        expect(getStateSnapshot().reservedCashMicros).toBe(5_000_000n);

        expect(releaseReservation("id-1")).toBe(true);
        expect(releaseReservation("id-1")).toBe(false);
        expect(getStateSnapshot().reservedCashMicros).toBe(0n);
    });

    it("reserves and releases shares for SELL and respects availability", () => {
        initializeFromReconciliation(
            0n,
            new Map<string, bigint>([["t1", 20_000_000n]])
        );

        const r1 = reserveSharesForSell("t1", 15_000_000n, "id-1");
        expect(r1.success).toBe(true);
        expect(getAvailableShares("t1")).toBe(5_000_000n);

        const r2 = reserveSharesForSell("t1", 10_000_000n, "id-2");
        expect(r2.success).toBe(false);

        expect(releaseReservation("id-1")).toBe(true);
        const r3 = reserveSharesForSell("t1", 10_000_000n, "id-2");
        expect(r3.success).toBe(true);
    });
});

describe("applyFill", () => {
    it("applies BUY fill and releases reservation", () => {
        initializeFromReconciliation(100_000_000n, new Map());

        const reservation = reserveCashForBuy("t1", 500_000, 10_000_000n, "id-1");
        expect(reservation.success).toBe(true);
        expect(getStateSnapshot().reservedCashMicros).toBe(5_000_000n);

        applyFill("t1", "BUY", 10_000_000n, 5_000_000n, 0n, "id-1");

        expect(getStateSnapshot().reservedCashMicros).toBe(0n);
        expect(getAvailableCash()).toBe(95_000_000n);
        expect(getAvailableShares("t1")).toBe(10_000_000n);
    });

    it("applies SELL fill and releases reservation", () => {
        initializeFromReconciliation(
            0n,
            new Map<string, bigint>([["t1", 10_000_000n]])
        );

        const reservation = reserveSharesForSell("t1", 10_000_000n, "id-1");
        expect(reservation.success).toBe(true);
        expect(getAvailableShares("t1")).toBe(0n);

        applyFill("t1", "SELL", 10_000_000n, 4_000_000n, 0n, "id-1");

        expect(getAvailableShares("t1")).toBe(0n);
        expect(getAvailableCash()).toBe(4_000_000n);
    });
});

describe("SUBMISSION_UNKNOWN pause gating", () => {
    it("pauses and resumes submissions and affects health", () => {
        initializeFromReconciliation(1_000_000n, new Map());
        expect(isStateHealthy()).toBe(true);

        pauseSubmissions("SUBMISSION_UNKNOWN order X");
        expect(areSubmissionsPaused()).toBe(true);
        expect(getPauseReason()).toBe("SUBMISSION_UNKNOWN order X");
        expect(isStateHealthy()).toBe(false);

        resumeSubmissions();
        expect(areSubmissionsPaused()).toBe(false);
        expect(getPauseReason()).toBe(null);
        expect(isStateHealthy()).toBe(true);
    });
});

