import { z } from "zod";

/**
 * Polymarket Data API trade schema.
 * Based on the trades endpoint response.
 */
export const PolymarketTradeSchema = z.object({
    id: z.string(),
    taker_order_id: z.string(),
    market: z.string(),
    asset_id: z.string(),
    side: z.enum(["BUY", "SELL"]),
    size: z.string(), // Decimal string for shares
    fee_rate_bps: z.string(),
    price: z.string(), // Decimal string 0-1
    status: z.string(),
    match_time: z.string(), // ISO timestamp
    last_update: z.string(),
    outcome: z.string(),
    bucket_index: z.number().optional(),
    owner: z.string(), // Wallet address
    maker_address: z.string(),
    transaction_hash: z.string(),
    trader_side: z.enum(["TAKER", "MAKER"]).optional(),
    type: z.string().optional(),
});

export type PolymarketTrade = z.infer<typeof PolymarketTradeSchema>;

/**
 * Asset amount in activity events.
 */
export const ActivityAssetSchema = z.object({
    asset_id: z.string(),
    amount: z.string(), // Decimal string
    outcome: z.string().optional(),
});

export type ActivityAsset = z.infer<typeof ActivityAssetSchema>;

/**
 * Polymarket activity event schema.
 * Handles MERGE, SPLIT, and REDEEM events from the activity feed.
 *
 * MERGE: User merges YES + NO tokens back into collateral (USDC)
 * SPLIT: User splits collateral into YES + NO token pairs
 * REDEEM: User redeems winning tokens for collateral after market resolution
 */
export const PolymarketActivitySchema = z.object({
    id: z.string(),
    type: z.enum(["TRADE", "MERGE", "SPLIT", "REDEEM"]),
    timestamp: z.string(), // ISO timestamp
    owner: z.string(), // Wallet address
    proxy_wallet: z.string().optional().nullable(),
    condition_id: z.string().optional(),
    market_slug: z.string().optional(),
    // For MERGE/SPLIT/REDEEM - the involved assets
    assets: z.array(ActivityAssetSchema).optional(),
    // For MERGE: collateral received
    collateral_amount: z.string().optional(),
    // Transaction details
    transaction_hash: z.string().optional(),
});

export type PolymarketActivity = z.infer<typeof PolymarketActivitySchema>;

/**
 * Activity payload for storing in DB JSON field.
 * Captures all relevant details for MERGE/SPLIT/REDEEM events.
 */
export interface ActivityPayload {
    conditionId?: string;
    marketSlug?: string;
    assets: Array<{
        assetId: string;
        amountMicros: string; // BigInt as string
        outcome?: string;
    }>;
    collateralAmountMicros?: string; // BigInt as string for MERGE
    transactionHash?: string;
}

/**
 * Order book level.
 */
export const OrderBookLevelSchema = z.object({
    price: z.string(), // Decimal string 0-1
    size: z.string(), // Decimal shares
});

export type OrderBookLevel = z.infer<typeof OrderBookLevelSchema>;

/**
 * Order book response.
 */
export const OrderBookSchema = z.object({
    market: z.string(),
    asset_id: z.string(),
    hash: z.string().optional(),
    timestamp: z.string().optional(),
    bids: z.array(OrderBookLevelSchema),
    asks: z.array(OrderBookLevelSchema),
});

export type OrderBook = z.infer<typeof OrderBookSchema>;

/**
 * Market info response.
 */
export const MarketInfoSchema = z.object({
    condition_id: z.string(),
    question_id: z.string().optional(),
    tokens: z.array(
        z.object({
            token_id: z.string(),
            outcome: z.string(),
            price: z.number().optional(),
        })
    ),
    minimum_order_size: z.string().optional(),
    minimum_tick_size: z.string().optional(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    accepting_orders: z.boolean().optional(),
    end_date_iso: z.string().optional(),
});

export type MarketInfo = z.infer<typeof MarketInfoSchema>;

/**
 * Price info for a token.
 */
export const TokenPriceSchema = z.object({
    token_id: z.string(),
    price: z.string(), // Decimal string 0-1
});

export type TokenPrice = z.infer<typeof TokenPriceSchema>;
