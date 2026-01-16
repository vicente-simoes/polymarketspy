/**
 * Unit tests for the OrderFilled event decoder.
 *
 * Tests all combinations of:
 * - Who gave USDC (maker vs taker)
 * - Who is the followed wallet (maker vs taker)
 * - Expected side derivation (BUY vs SELL)
 */

import { describe, it, expect } from "vitest";
import { deriveTradeFields, type TrackedWalletInfo } from "./decoder.js";
import { USDC_ASSET_ID, type ParsedFillEvent } from "./types.js";

// Test constants
const MAKER_ADDRESS = "0xMakerAddress1234567890123456789012345678";
const TAKER_ADDRESS = "0xTakerAddress1234567890123456789012345678";
const PROFILE_WALLET = "0xProfileWallet12345678901234567890123456";
const EXCHANGE_ADDRESS = "0xExchangeAddress12345678901234567890123";
const OUTCOME_TOKEN_ID = 123456789012345678901234567890n; // Large token ID
const TX_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const ORDER_HASH = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

/**
 * Create a mock ParsedFillEvent for testing.
 */
function createMockEvent(overrides: Partial<ParsedFillEvent> = {}): ParsedFillEvent {
    return {
        txHash: TX_HASH,
        logIndex: 5,
        blockNumber: 12345678,
        orderHash: ORDER_HASH,
        maker: MAKER_ADDRESS,
        taker: TAKER_ADDRESS,
        makerAssetId: USDC_ASSET_ID, // Default: maker gave USDC
        takerAssetId: OUTCOME_TOKEN_ID, // Default: taker gave tokens
        makerAmountFilled: 100_000_000n, // 100 USDC (6 decimals)
        takerAmountFilled: 200_000_000n, // 200 tokens (6 decimals)
        fee: 500_000n, // 0.5 USDC fee
        removed: false,
        ...overrides,
    };
}

/**
 * Create mock wallet info for testing.
 */
function createWalletInfo(overrides: Partial<TrackedWalletInfo> = {}): TrackedWalletInfo {
    return {
        followedUserId: "user-123",
        profileWallet: PROFILE_WALLET,
        isProxy: false,
        ...overrides,
    };
}

describe("deriveTradeFields", () => {
    describe("side derivation - all combinations", () => {
        it("should derive BUY when maker gave USDC and followed is maker", () => {
            // Setup: Maker gave USDC (buying tokens), followed wallet is maker
            const event = createMockEvent({
                maker: MAKER_ADDRESS,
                taker: TAKER_ADDRESS,
                makerAssetId: USDC_ASSET_ID, // Maker gave USDC
                takerAssetId: OUTCOME_TOKEN_ID, // Taker gave tokens
                makerAmountFilled: 100_000_000n, // USDC amount
                takerAmountFilled: 200_000_000n, // Token amount
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.side).toBe("BUY");
            expect(result.role).toBe("MAKER");
            expect(result.outcomeTokenId).toBe(OUTCOME_TOKEN_ID.toString());
            expect(result.usdcAmountMicros).toBe(100_000_000n);
            expect(result.tokenAmountMicros).toBe(200_000_000n);
        });

        it("should derive SELL when maker gave USDC and followed is taker", () => {
            // Setup: Maker gave USDC (buying tokens), followed wallet is taker (selling)
            const event = createMockEvent({
                maker: MAKER_ADDRESS,
                taker: TAKER_ADDRESS,
                makerAssetId: USDC_ASSET_ID, // Maker gave USDC
                takerAssetId: OUTCOME_TOKEN_ID, // Taker gave tokens
                makerAmountFilled: 100_000_000n, // USDC amount
                takerAmountFilled: 200_000_000n, // Token amount
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, TAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.side).toBe("SELL");
            expect(result.role).toBe("TAKER");
            expect(result.outcomeTokenId).toBe(OUTCOME_TOKEN_ID.toString());
            expect(result.usdcAmountMicros).toBe(100_000_000n);
            expect(result.tokenAmountMicros).toBe(200_000_000n);
        });

        it("should derive SELL when taker gave USDC and followed is maker", () => {
            // Setup: Taker gave USDC (buying tokens), followed wallet is maker (selling)
            const event = createMockEvent({
                maker: MAKER_ADDRESS,
                taker: TAKER_ADDRESS,
                makerAssetId: OUTCOME_TOKEN_ID, // Maker gave tokens
                takerAssetId: USDC_ASSET_ID, // Taker gave USDC
                makerAmountFilled: 200_000_000n, // Token amount
                takerAmountFilled: 100_000_000n, // USDC amount
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.side).toBe("SELL");
            expect(result.role).toBe("MAKER");
            expect(result.outcomeTokenId).toBe(OUTCOME_TOKEN_ID.toString());
            expect(result.usdcAmountMicros).toBe(100_000_000n);
            expect(result.tokenAmountMicros).toBe(200_000_000n);
        });

        it("should derive BUY when taker gave USDC and followed is taker", () => {
            // Setup: Taker gave USDC (buying tokens), followed wallet is taker
            const event = createMockEvent({
                maker: MAKER_ADDRESS,
                taker: TAKER_ADDRESS,
                makerAssetId: OUTCOME_TOKEN_ID, // Maker gave tokens
                takerAssetId: USDC_ASSET_ID, // Taker gave USDC
                makerAmountFilled: 200_000_000n, // Token amount
                takerAmountFilled: 100_000_000n, // USDC amount
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, TAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.side).toBe("BUY");
            expect(result.role).toBe("TAKER");
            expect(result.outcomeTokenId).toBe(OUTCOME_TOKEN_ID.toString());
            expect(result.usdcAmountMicros).toBe(100_000_000n);
            expect(result.tokenAmountMicros).toBe(200_000_000n);
        });
    });

    describe("price computation", () => {
        it("should compute correct price for 50 cent trade", () => {
            // 100 USDC for 200 tokens = $0.50 per token = 500,000 micros
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 100_000_000n, // 100 USDC
                takerAmountFilled: 200_000_000n, // 200 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.priceMicros).toBe(500_000); // 0.50 = 500,000 micros
        });

        it("should compute correct price for 1 cent trade", () => {
            // 1 USDC for 100 tokens = $0.01 per token = 10,000 micros
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 1_000_000n, // 1 USDC
                takerAmountFilled: 100_000_000n, // 100 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.priceMicros).toBe(10_000); // 0.01 = 10,000 micros
        });

        it("should compute correct price for 99 cent trade", () => {
            // 99 USDC for 100 tokens = $0.99 per token = 990,000 micros
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 99_000_000n, // 99 USDC
                takerAmountFilled: 100_000_000n, // 100 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.priceMicros).toBe(990_000); // 0.99 = 990,000 micros
        });

        it("should handle small amounts without precision loss", () => {
            // 0.001 USDC for 0.002 tokens = $0.50 per token
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 1_000n, // 0.001 USDC
                takerAmountFilled: 2_000n, // 0.002 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.priceMicros).toBe(500_000); // 0.50 = 500,000 micros
        });

        it("should handle large amounts", () => {
            // 10,000 USDC for 20,000 tokens = $0.50 per token
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 10_000_000_000n, // 10,000 USDC
                takerAmountFilled: 20_000_000_000n, // 20,000 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.priceMicros).toBe(500_000);
        });

        it("should clamp price to 1_000_000 if it exceeds 1.0", () => {
            // Edge case: More USDC than tokens (shouldn't happen in practice)
            // 200 USDC for 100 tokens = $2.00 per token -> clamped to 1.0
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 200_000_000n, // 200 USDC
                takerAmountFilled: 100_000_000n, // 100 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.priceMicros).toBe(1_000_000); // Clamped to max
        });

        it("should return 0 price when token amount is 0", () => {
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 100_000_000n,
                takerAmountFilled: 0n, // No tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.priceMicros).toBe(0);
        });
    });

    describe("fee extraction", () => {
        it("should extract fee correctly", () => {
            const event = createMockEvent({
                fee: 500_000n, // 0.5 USDC
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.feeMicros).toBe(500_000n);
        });

        it("should handle zero fee", () => {
            const event = createMockEvent({
                fee: 0n,
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.feeMicros).toBe(0n);
        });

        it("should handle large fee", () => {
            const event = createMockEvent({
                fee: 10_000_000n, // 10 USDC
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.feeMicros).toBe(10_000_000n);
        });
    });

    describe("wallet info preservation", () => {
        it("should preserve profileWallet from walletInfo", () => {
            const event = createMockEvent();
            const walletInfo = createWalletInfo({
                profileWallet: "0xMyProfileWallet123456789012345678901234",
            });

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.profileWallet).toBe("0xMyProfileWallet123456789012345678901234");
        });

        it("should set isProxy=false for non-proxy wallet", () => {
            const event = createMockEvent();
            const walletInfo = createWalletInfo({ isProxy: false });

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.isProxy).toBe(false);
        });

        it("should set isProxy=true for proxy wallet", () => {
            const event = createMockEvent();
            const walletInfo = createWalletInfo({ isProxy: true });

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.isProxy).toBe(true);
        });
    });

    describe("event metadata preservation", () => {
        it("should preserve all raw event fields", () => {
            const event = createMockEvent({
                txHash: "0xspecifictxhash",
                logIndex: 42,
                blockNumber: 99999999,
                orderHash: "0xspecificorderhash",
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.txHash).toBe("0xspecifictxhash");
            expect(result.logIndex).toBe(42);
            expect(result.blockNumber).toBe(99999999);
            expect(result.orderHash).toBe("0xspecificorderhash");
            expect(result.exchangeAddress).toBe(EXCHANGE_ADDRESS);
        });

        it("should preserve maker and taker addresses", () => {
            const event = createMockEvent();
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.maker).toBe(MAKER_ADDRESS);
            expect(result.taker).toBe(TAKER_ADDRESS);
        });

        it("should set followedWallet to the provided wallet", () => {
            const event = createMockEvent();
            const walletInfo = createWalletInfo();

            const makerResult = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);
            const takerResult = deriveTradeFields(event, TAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(makerResult.followedWallet).toBe(MAKER_ADDRESS);
            expect(takerResult.followedWallet).toBe(TAKER_ADDRESS);
        });
    });

    describe("case-insensitive address comparison", () => {
        it("should match maker regardless of case", () => {
            const event = createMockEvent({
                maker: "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(
                event,
                "0xabcdef1234567890abcdef1234567890abcdef12", // lowercase
                walletInfo,
                EXCHANGE_ADDRESS
            );

            expect(result.role).toBe("MAKER");
        });

        it("should match taker regardless of case", () => {
            const event = createMockEvent({
                taker: "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(
                event,
                "0xABCDEF1234567890ABCDEF1234567890ABCDEF12", // uppercase
                walletInfo,
                EXCHANGE_ADDRESS
            );

            expect(result.role).toBe("TAKER");
        });
    });

    describe("notional and share amounts", () => {
        it("should set notionalMicros to USDC amount", () => {
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 150_000_000n, // 150 USDC
                takerAmountFilled: 300_000_000n, // 300 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.notionalMicros).toBe(150_000_000n);
        });

        it("should set shareMicros to token amount", () => {
            const event = createMockEvent({
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: OUTCOME_TOKEN_ID,
                makerAmountFilled: 150_000_000n, // 150 USDC
                takerAmountFilled: 300_000_000n, // 300 tokens
            });
            const walletInfo = createWalletInfo();

            const result = deriveTradeFields(event, MAKER_ADDRESS, walletInfo, EXCHANGE_ADDRESS);

            expect(result.shareMicros).toBe(300_000_000n);
        });
    });
});
