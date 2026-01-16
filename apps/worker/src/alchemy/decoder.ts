/**
 * OrderFilled event decoder and trade field derivation.
 *
 * This module takes a raw ParsedFillEvent and tracked wallet info,
 * and derives all fields needed to create a canonical TradeEvent.
 *
 * Key computations:
 * - Determine which assetId is USDC (collateral) vs outcome token
 * - Compute trade side (BUY/SELL) from followed wallet's perspective
 * - Compute price in micros using integer math (no floats)
 */

import {
    USDC_ASSET_ID,
    type ParsedFillEvent,
    type DecodedOrderFilled,
    type FillRole,
} from "./types.js";

/**
 * Info about a tracked wallet from the cache.
 */
export interface TrackedWalletInfo {
    followedUserId: string;
    profileWallet: string;
    isProxy: boolean;
}

/**
 * Derive all trade fields from a parsed OrderFilled event.
 *
 * @param event - The parsed OrderFilled log event
 * @param followedWallet - The tracked wallet address (maker or taker)
 * @param walletInfo - Info about the tracked wallet (profile vs proxy)
 * @param exchangeAddress - The contract address that emitted the event
 * @returns Fully decoded event with all derived fields
 */
export function deriveTradeFields(
    event: ParsedFillEvent,
    followedWallet: string,
    walletInfo: TrackedWalletInfo,
    exchangeAddress: string
): DecodedOrderFilled {
    const {
        txHash,
        logIndex,
        blockNumber,
        orderHash,
        maker,
        taker,
        makerAssetId,
        takerAssetId,
        makerAmountFilled,
        takerAmountFilled,
        fee,
    } = event;

    // 1. Identify which side has USDC (assetId == 0)
    const makerGaveUsdc = makerAssetId === USDC_ASSET_ID;
    const takerGaveUsdc = takerAssetId === USDC_ASSET_ID;

    // Validate: exactly one side should be USDC for a standard outcome token fill
    if (makerGaveUsdc === takerGaveUsdc) {
        // Both or neither are USDC - this shouldn't happen for normal fills
        // Log warning but continue with best-effort parsing
        console.warn(
            `[decoder] Unexpected assetId configuration: makerAssetId=${makerAssetId}, takerAssetId=${takerAssetId}`
        );
    }

    // 2. Extract outcome token ID (the non-USDC assetId)
    const outcomeTokenId = makerGaveUsdc
        ? takerAssetId.toString()
        : makerAssetId.toString();

    // 3. Extract amounts
    // If maker gave USDC, maker's amount is USDC, taker's amount is tokens
    // If taker gave USDC, taker's amount is USDC, maker's amount is tokens
    const usdcAmountMicros = makerGaveUsdc ? makerAmountFilled : takerAmountFilled;
    const tokenAmountMicros = makerGaveUsdc ? takerAmountFilled : makerAmountFilled;

    // 4. Determine role of followed wallet
    const isMaker = maker.toLowerCase() === followedWallet.toLowerCase();
    const role: FillRole = isMaker ? "MAKER" : "TAKER";

    // 5. Determine side from followed wallet's perspective
    // Think about what each party gives and receives:
    //
    // If makerGaveUsdc (maker gave USDC, received tokens):
    //   - Maker is BUYING tokens (gave USDC, got tokens)
    //   - Taker is SELLING tokens (gave tokens, got USDC)
    //
    // If takerGaveUsdc (taker gave USDC, received tokens):
    //   - Taker is BUYING tokens (gave USDC, got tokens)
    //   - Maker is SELLING tokens (gave tokens, got USDC)
    //
    // So: followed wallet is BUYING if they gave USDC
    const followedGaveUsdc = (isMaker && makerGaveUsdc) || (!isMaker && takerGaveUsdc);
    const side = followedGaveUsdc ? "BUY" : "SELL";

    // 6. Compute price in micros using integer math
    // Price = USDC per token = usdcAmount / tokenAmount
    // To get priceMicros (0..1_000_000 representing 0..1):
    // priceMicros = (usdcAmount * 1_000_000) / tokenAmount
    //
    // Note: Both amounts are in 6-decimal micros, so the division gives
    // a ratio. Multiplying by 1_000_000 converts to our price scale.
    let priceMicros = 0;
    if (tokenAmountMicros > 0n) {
        // Integer division with proper scaling
        priceMicros = Number((usdcAmountMicros * 1_000_000n) / tokenAmountMicros);
        // Clamp to valid range (shouldn't exceed 1_000_000 for valid prices)
        priceMicros = Math.min(priceMicros, 1_000_000);
    }

    // 7. Set notional and shares (already in micros)
    const notionalMicros = usdcAmountMicros;
    const shareMicros = tokenAmountMicros;
    const feeMicros = fee;

    return {
        // From raw log
        txHash,
        logIndex,
        blockNumber,
        exchangeAddress,

        // Raw event fields
        orderHash,
        maker,
        taker,
        makerAssetId,
        takerAssetId,
        makerAmountFilled,
        takerAmountFilled,
        fee,

        // Derived fields
        outcomeTokenId,
        usdcAmountMicros,
        tokenAmountMicros,
        followedWallet,
        isProxy: walletInfo.isProxy,
        profileWallet: walletInfo.profileWallet,
        role,
        side,
        priceMicros,
        notionalMicros,
        shareMicros,
        feeMicros,

        // Timestamps
        detectTime: new Date(),
    };
}
