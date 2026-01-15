import { z } from "zod";

/**
 * Polymarket Data API trade schema.
 * Based on the trades endpoint response (supports legacy + current fields).
 */
const NumericSchema = z.union([z.string(), z.number()]);

export const PolymarketTradeSchema = z.object({
    // Wallet info
    proxyWallet: z.string().optional().nullable(), // Current API field
    owner: z.string().optional().nullable(), // Legacy field
    maker_address: z.string().optional().nullable(), // Legacy field

    // Trade details
    side: z.enum(["BUY", "SELL"]),
    size: NumericSchema, // Shares
    usdcSize: NumericSchema.optional().nullable(), // USDC notional
    price: NumericSchema.optional().nullable(), // 0-1

    // Market info
    marketId: z.string().optional().nullable(),
    market: z.string().optional().nullable(), // Legacy market id
    conditionId: z.string().optional().nullable(),
    slug: z.string().optional().nullable(),
    asset: z.string().optional().nullable(),
    assetId: z.string().optional().nullable(),
    asset_id: z.string().optional().nullable(), // Legacy asset id
    outcome: z.string().optional().nullable(),
    outcomeIndex: z.number().optional().nullable(),

    // Timing + tx
    timestamp: z.number().optional(), // Unix timestamp (seconds)
    match_time: z.string().optional().nullable(), // Legacy ISO timestamp
    transactionHash: z.string().optional().nullable(),
    transaction_hash: z.string().optional().nullable(), // Legacy field

    // Legacy identifiers
    id: z.string().optional().nullable(),
    taker_order_id: z.string().optional().nullable(),
    fee_rate_bps: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    last_update: z.string().optional().nullable(),
    bucket_index: z.number().optional(),
    trader_side: z.enum(["TAKER", "MAKER"]).optional(),
    type: z.string().optional(),
});

export type PolymarketTrade = z.infer<typeof PolymarketTradeSchema>;

// Handle empty string or null from API by allowing optional BUY/SELL
// Using union to accept empty strings and converting them in app code
const ActivitySideSchema = z
    .union([z.literal("BUY"), z.literal("SELL"), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" || v === null ? undefined : v) as "BUY" | "SELL" | undefined);

/**
 * Polymarket activity event schema.
 * Based on the Data API /activity endpoint response docs.
 *
 * Activity types:
 * - TRADE: Buy/sell trades
 * - MERGE: User merges YES + NO tokens back into collateral (USDC)
 * - SPLIT: User splits collateral into YES + NO token pairs
 * - REDEEM: User redeems winning tokens for collateral after market resolution
 * - REWARD: Reward payouts
 * - CONVERSION: Token conversions
 * - MAKER_REBATE: Maker fee rebates
 */
export const PolymarketActivitySchema = z.object({
    // User/wallet info
    proxyWallet: z.string(), // User address (0x-prefixed)
    name: z.string().optional().nullable(),
    pseudonym: z.string().optional().nullable(),
    bio: z.string().optional().nullable(),
    profileImage: z.string().optional().nullable(),
    profileImageOptimized: z.string().optional().nullable(),

    // Activity details
    type: z.enum(["TRADE", "MERGE", "SPLIT", "REDEEM", "REWARD", "CONVERSION", "MAKER_REBATE"]),
    timestamp: z.number(), // Unix timestamp (integer)
    side: ActivitySideSchema,

    // Market info
    conditionId: z.string().optional().nullable(), // Market condition ID
    title: z.string().optional().nullable(), // Market title
    slug: z.string().optional().nullable(), // Market URL slug
    eventSlug: z.string().optional().nullable(), // Event URL slug
    icon: z.string().optional().nullable(), // Market icon URL
    outcome: z.string().optional().nullable(), // Outcome description
    outcomeIndex: z.number().optional().nullable(), // Outcome position

    // Transaction details
    asset: z.string().optional().nullable(), // Asset identifier
    size: NumericSchema.optional().nullable(), // Token quantity
    usdcSize: NumericSchema.optional().nullable(), // USDC equivalent value
    price: NumericSchema.optional().nullable(), // Transaction price
    transactionHash: z.string().optional().nullable(), // On-chain tx hash
});

export type PolymarketActivity = z.output<typeof PolymarketActivitySchema>;

/**
 * Activity payload for storing in DB JSON field.
 * Captures all relevant details for MERGE/SPLIT/REDEEM events.
 */
export interface ActivityPayload {
    conditionId?: string | null;
    marketSlug?: string | null;
    marketTitle?: string | null;
    outcome?: string | null;
    outcomeIndex?: number | null;
    transactionHash?: string | null;
    assets?: Array<{
        assetId: string;
        amountMicros: string; // Token quantity as micros (BigInt as string)
    }>;
    collateralAmountMicros?: string; // USDC equivalent as micros (BigInt as string)
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
