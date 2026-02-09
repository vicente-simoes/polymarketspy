import { describe, it, expect } from "vitest";
import { TradeSide } from "@prisma/client";
import { generateIdempotencyKey } from "./idempotency.js";

describe("generateIdempotencyKey", () => {
    it("is deterministic for identical inputs", () => {
        const a = generateIdempotencyKey("u1", "t1", TradeSide.BUY, "g1");
        const b = generateIdempotencyKey("u1", "t1", TradeSide.BUY, "g1");
        expect(a).toBe(b);
        expect(a.startsWith("v1_")).toBe(true);
    });

    it("changes when any basis field changes", () => {
        const base = generateIdempotencyKey("u1", "t1", TradeSide.BUY, "g1");
        expect(generateIdempotencyKey("u2", "t1", TradeSide.BUY, "g1")).not.toBe(base);
        expect(generateIdempotencyKey("u1", "t2", TradeSide.BUY, "g1")).not.toBe(base);
        expect(generateIdempotencyKey("u1", "t1", TradeSide.SELL, "g1")).not.toBe(base);
        expect(generateIdempotencyKey("u1", "t1", TradeSide.BUY, "g2")).not.toBe(base);
    });
});

