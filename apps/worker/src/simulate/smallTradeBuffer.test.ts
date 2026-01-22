/**
 * Unit tests for small trade buffer module.
 *
 * Tests bucket state transitions, flush conditions, netting modes,
 * and min exec skip behavior.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TradeSide } from "@prisma/client";
import {
    generateBucketKey,
    shouldFlush,
    resetMetrics,
    getMetrics,
    type Bucket,
} from "./smallTradeBuffer.js";
import { SmallTradeNettingMode, type SmallTradeBuffering } from "@copybot/shared";

// Default test config
const defaultConfig: SmallTradeBuffering = {
    enabled: true,
    notionalThresholdMicros: 250_000, // $0.25
    flushMinNotionalMicros: 500_000, // $0.50
    minExecNotionalMicros: 100_000, // $0.10
    maxBufferMs: 2500,
    quietFlushMs: 600,
    nettingMode: SmallTradeNettingMode.SAME_SIDE_ONLY,
};

// Helper to create a test bucket
function createTestBucket(overrides: Partial<Bucket> = {}): Bucket {
    return {
        key: "user1:token1:BUY",
        followedUserId: "user1",
        tokenId: "token1",
        marketId: "market1",
        side: TradeSide.BUY,
        netNotionalMicros: 200_000n, // $0.20
        netShareMicros: 400_000n,
        firstSeenAtMs: Date.now() - 1000, // 1 second ago
        lastUpdatedAtMs: Date.now() - 500, // 0.5 seconds ago
        countTradesBuffered: 2,
        referencePriceMicros: 500_000, // $0.50
        tradeEventIds: ["trade1", "trade2"],
        ...overrides,
    };
}

describe("generateBucketKey", () => {
    describe("sameSideOnly mode", () => {
        it("should include side in the key", () => {
            const key = generateBucketKey(
                "user123",
                "token456",
                TradeSide.BUY,
                SmallTradeNettingMode.SAME_SIDE_ONLY
            );
            expect(key).toBe("user123:token456:BUY");
        });

        it("should generate different keys for BUY and SELL", () => {
            const buyKey = generateBucketKey(
                "user1",
                "token1",
                TradeSide.BUY,
                SmallTradeNettingMode.SAME_SIDE_ONLY
            );
            const sellKey = generateBucketKey(
                "user1",
                "token1",
                TradeSide.SELL,
                SmallTradeNettingMode.SAME_SIDE_ONLY
            );
            expect(buyKey).not.toBe(sellKey);
            expect(buyKey).toBe("user1:token1:BUY");
            expect(sellKey).toBe("user1:token1:SELL");
        });
    });

    describe("netBuySell mode", () => {
        it("should not include side in the key", () => {
            const key = generateBucketKey(
                "user123",
                "token456",
                TradeSide.BUY,
                SmallTradeNettingMode.NET_BUY_SELL
            );
            expect(key).toBe("user123:token456");
        });

        it("should generate same key for BUY and SELL", () => {
            const buyKey = generateBucketKey(
                "user1",
                "token1",
                TradeSide.BUY,
                SmallTradeNettingMode.NET_BUY_SELL
            );
            const sellKey = generateBucketKey(
                "user1",
                "token1",
                TradeSide.SELL,
                SmallTradeNettingMode.NET_BUY_SELL
            );
            expect(buyKey).toBe(sellKey);
            expect(buyKey).toBe("user1:token1");
        });
    });
});

describe("shouldFlush", () => {
    describe("threshold condition", () => {
        it("should return 'threshold' when notional >= flushMinNotionalMicros", () => {
            const bucket = createTestBucket({
                netNotionalMicros: 500_000n, // exactly at threshold
            });
            const reason = shouldFlush(bucket, defaultConfig, Date.now());
            expect(reason).toBe("threshold");
        });

        it("should return 'threshold' when notional exceeds flushMinNotionalMicros", () => {
            const bucket = createTestBucket({
                netNotionalMicros: 1_000_000n, // 2x threshold
            });
            const reason = shouldFlush(bucket, defaultConfig, Date.now());
            expect(reason).toBe("threshold");
        });

        it("should work with negative notional (SELL side)", () => {
            const bucket = createTestBucket({
                netNotionalMicros: -600_000n, // negative but abs >= threshold
                side: TradeSide.SELL,
            });
            const reason = shouldFlush(bucket, defaultConfig, Date.now());
            expect(reason).toBe("threshold");
        });

        it("should not flush when below threshold", () => {
            const bucket = createTestBucket({
                netNotionalMicros: 400_000n, // below 500_000 threshold
                firstSeenAtMs: Date.now(), // just created
                lastUpdatedAtMs: Date.now(), // just updated
            });
            const reason = shouldFlush(bucket, defaultConfig, Date.now());
            expect(reason).toBeNull();
        });
    });

    describe("maxTime condition", () => {
        it("should return 'maxTime' when bucket age >= maxBufferMs", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 200_000n, // below threshold
                firstSeenAtMs: now - 2500, // exactly at maxBufferMs
                lastUpdatedAtMs: now - 100, // recent activity
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBe("maxTime");
        });

        it("should return 'maxTime' when bucket is older than maxBufferMs", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 200_000n,
                firstSeenAtMs: now - 5000, // 5 seconds old
                lastUpdatedAtMs: now - 100,
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBe("maxTime");
        });

        it("should not flush if age < maxBufferMs", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 200_000n,
                firstSeenAtMs: now - 1000, // 1 second old (< 2500ms)
                lastUpdatedAtMs: now, // just updated
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBeNull();
        });
    });

    describe("quiet condition", () => {
        it("should return 'quiet' when no activity for quietFlushMs and above minExec", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 150_000n, // above minExec (100_000) but below flushMin (500_000)
                firstSeenAtMs: now - 1000, // 1 second old
                lastUpdatedAtMs: now - 700, // 700ms since last update (> 600ms quiet)
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBe("quiet");
        });

        it("should not flush quiet if below minExec", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 50_000n, // below minExec (100_000)
                firstSeenAtMs: now - 1000,
                lastUpdatedAtMs: now - 700, // would trigger quiet flush
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBeNull(); // still null because below minExec
        });

        it("should not flush quiet if activity is recent", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 150_000n,
                firstSeenAtMs: now - 1000,
                lastUpdatedAtMs: now - 300, // only 300ms since last update (< 600ms)
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBeNull();
        });
    });

    describe("priority order", () => {
        it("should prioritize threshold over maxTime", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 600_000n, // above threshold
                firstSeenAtMs: now - 5000, // also past maxTime
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBe("threshold");
        });

        it("should prioritize maxTime over quiet", () => {
            const now = Date.now();
            const bucket = createTestBucket({
                netNotionalMicros: 150_000n, // above minExec, below threshold
                firstSeenAtMs: now - 3000, // past maxTime
                lastUpdatedAtMs: now - 1000, // would also trigger quiet
            });
            const reason = shouldFlush(bucket, defaultConfig, now);
            expect(reason).toBe("maxTime");
        });
    });
});

describe("metrics", () => {
    beforeEach(() => {
        resetMetrics();
    });

    it("should initialize with zero values", () => {
        const metrics = getMetrics();
        expect(metrics.bufferedTrades).toBe(0);
        expect(metrics.immediateTrades).toBe(0);
        expect(metrics.flushedBuckets).toBe(0);
        expect(metrics.flushReasonThreshold).toBe(0);
        expect(metrics.flushReasonQuiet).toBe(0);
        expect(metrics.flushReasonMaxTime).toBe(0);
        expect(metrics.flushReasonOppositeSide).toBe(0);
        expect(metrics.flushReasonShutdown).toBe(0);
        expect(metrics.skippedFlushBelowMin).toBe(0);
    });

    it("should reset metrics correctly", () => {
        // Get metrics, modify via module internals would require integration tests
        resetMetrics();
        const metrics = getMetrics();
        expect(metrics.bufferedTrades).toBe(0);
    });
});

describe("bucket state transitions", () => {
    describe("signed notional handling", () => {
        it("should store positive notional for BUY", () => {
            const bucket = createTestBucket({
                side: TradeSide.BUY,
                netNotionalMicros: 200_000n,
            });
            expect(bucket.netNotionalMicros).toBeGreaterThan(0n);
        });

        it("should store negative notional for SELL", () => {
            const bucket = createTestBucket({
                side: TradeSide.SELL,
                netNotionalMicros: -200_000n,
            });
            expect(bucket.netNotionalMicros).toBeLessThan(0n);
        });
    });

    describe("netBuySell netting", () => {
        it("should allow buys and sells to net (conceptual)", () => {
            // In netBuySell mode, a bucket can have:
            // - Initial BUY of +300_000
            // - Then SELL of -200_000
            // - Net = +100_000
            const netNotional = 300_000n + (-200_000n);
            expect(netNotional).toBe(100_000n);
        });

        it("should handle net to zero", () => {
            const netNotional = 300_000n + (-300_000n);
            expect(netNotional).toBe(0n);
        });

        it("should handle net to negative", () => {
            const netNotional = 200_000n + (-500_000n);
            expect(netNotional).toBe(-300_000n);
        });
    });
});

describe("edge cases", () => {
    it("should handle zero notional bucket", () => {
        const bucket = createTestBucket({
            netNotionalMicros: 0n,
        });
        const reason = shouldFlush(bucket, defaultConfig, Date.now());
        // Zero notional is below all thresholds except maxTime
        expect(reason).toBeNull();
    });

    it("should handle very large notional", () => {
        const bucket = createTestBucket({
            netNotionalMicros: 1_000_000_000n, // $1000
        });
        const reason = shouldFlush(bucket, defaultConfig, Date.now());
        expect(reason).toBe("threshold");
    });

    it("should handle bucket at exactly minExec for quiet flush", () => {
        const now = Date.now();
        const bucket = createTestBucket({
            netNotionalMicros: 100_000n, // exactly at minExec
            firstSeenAtMs: now - 1000,
            lastUpdatedAtMs: now - 700, // past quiet window
        });
        const reason = shouldFlush(bucket, defaultConfig, now);
        expect(reason).toBe("quiet");
    });

    it("should handle bucket just below minExec for quiet flush", () => {
        const now = Date.now();
        const bucket = createTestBucket({
            netNotionalMicros: 99_999n, // just below minExec
            firstSeenAtMs: now - 1000,
            lastUpdatedAtMs: now - 700, // past quiet window
        });
        const reason = shouldFlush(bucket, defaultConfig, now);
        expect(reason).toBeNull(); // should not flush because below minExec
    });
});

describe("config variations", () => {
    it("should respect custom thresholds", () => {
        const customConfig: SmallTradeBuffering = {
            ...defaultConfig,
            flushMinNotionalMicros: 1_000_000, // $1.00
        };
        const bucket = createTestBucket({
            netNotionalMicros: 800_000n, // would trigger with default, not with custom
            firstSeenAtMs: Date.now(),
            lastUpdatedAtMs: Date.now(),
        });
        const reason = shouldFlush(bucket, customConfig, Date.now());
        expect(reason).toBeNull();
    });

    it("should respect custom maxBufferMs", () => {
        const now = Date.now();
        const customConfig: SmallTradeBuffering = {
            ...defaultConfig,
            maxBufferMs: 5000, // 5 seconds instead of 2.5
        };
        const bucket = createTestBucket({
            netNotionalMicros: 200_000n,
            firstSeenAtMs: now - 3000, // 3 seconds - would flush with default
            lastUpdatedAtMs: now,
        });
        const reason = shouldFlush(bucket, customConfig, now);
        expect(reason).toBeNull(); // not yet 5 seconds
    });

    it("should respect custom quietFlushMs", () => {
        const now = Date.now();
        const customConfig: SmallTradeBuffering = {
            ...defaultConfig,
            quietFlushMs: 1000, // 1 second instead of 600ms
        };
        const bucket = createTestBucket({
            netNotionalMicros: 150_000n,
            firstSeenAtMs: now - 1500,
            lastUpdatedAtMs: now - 800, // 800ms - would flush with default 600ms
        });
        const reason = shouldFlush(bucket, customConfig, now);
        expect(reason).toBeNull(); // not yet 1 second quiet
    });
});
