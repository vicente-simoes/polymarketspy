/**
 * Authenticated CLOB Client Wrapper
 *
 * This module wraps the official @polymarket/clob-client for:
 * - Order placement (FAK orders for copy trading)
 * - Order queries (for reconciliation)
 * - Account state (balance, positions)
 *
 * Key features:
 * - Centralized unit conversion (micros <-> decimal strings)
 * - Error normalization to our reason codes
 * - Optional initialization (worker runs without key for paper-only mode)
 */

import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { env } from "../config/env.js";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "clob-client" });

// ─── Constants ────────────────────────────────────────────────────────────────

const CHAIN_ID = 137; // Polygon mainnet

// ─── Type Definitions ─────────────────────────────────────────────────────────

/** Order placement parameters */
export interface PlaceOrderParams {
    tokenId: string;
    side: "BUY" | "SELL";
    priceMicros: number; // 0..1_000_000
    sizeShareMicros: bigint; // in share micros
}

/** Result of order placement */
export type PlaceOrderResult =
    | { success: true; clobOrderId: string; status: ClobOrderStatus }
    | { success: false; error: ClobOrderError };

export type ClobOrderStatus =
    | "LIVE"
    | "OPEN"
    | "PARTIAL"
    | "FILLED"
    | "CANCELED"
    | "MATCHED"
    | "REJECTED";

export interface ClobOrderError {
    code: string;
    message: string;
    isRetryable: boolean;
}

/** Order info from exchange */
export interface ClobOrder {
    clobOrderId: string;
    tokenId: string;
    side: "BUY" | "SELL";
    price: string; // decimal string
    originalSize: string; // decimal string
    filledSize: string; // decimal string
    status: ClobOrderStatus;
    createdAt: number;
}

/** Trade info from exchange (for reconciliation matching). */
export interface ClobTrade {
    tradeId: string;
    tokenId: string;
    side: "BUY" | "SELL";
    status: string;
    matchTimeMs: number;
    traderSide: "TAKER" | "MAKER" | "UNKNOWN";
    takerOrderId: string | null;
    makerOrderIds: string[];
}

/** Account balance */
export interface AccountBalance {
    cashMicros: bigint; // USDC balance in micros
    allowanceMicros: bigint; // Allowance in micros
}

/** Position entry (from exchange, if available) */
export interface Position {
    tokenId: string;
    shareMicros: bigint;
}

// ─── Type Definitions (API Credentials) ──────────────────────────────────────

/** API credentials for authenticated requests */
export interface ApiKeyCreds {
    key: string;
    secret: string;
    passphrase: string;
}

// ─── Module State ─────────────────────────────────────────────────────────────

let client: ClobClient | null = null;
let walletAddress: string | null = null;
let apiCreds: ApiKeyCreds | null = null;
let isInitialized = false;

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Check if live trading client is available (key configured).
 */
export function isLiveClientAvailable(): boolean {
    return !!env.POLYMARKET_LIVE_PRIVATE_KEY;
}

/**
 * Check if the client has been initialized.
 */
export function isLiveClientInitialized(): boolean {
    return isInitialized;
}

/**
 * Get the wallet address (only available after initialization).
 */
export function getWalletAddress(): string | null {
    return walletAddress;
}

/**
 * Get API credentials for WebSocket authentication (only available after initialization).
 */
export function getApiCredentials(): ApiKeyCreds | null {
    return apiCreds;
}

/**
 * Initialize the authenticated client (call once on startup).
 *
 * @returns true if initialization succeeded, false otherwise
 */
export async function initializeLiveClient(): Promise<boolean> {
    if (isInitialized) {
        logger.debug("CLOB client already initialized");
        return true;
    }

    if (!env.POLYMARKET_LIVE_PRIVATE_KEY) {
        logger.info("Live trading key not configured, skipping client init");
        return false;
    }

    try {
        // Create signer from private key (using ethers v5 Wallet for CLOB client compatibility)
        const signer = new Wallet(env.POLYMARKET_LIVE_PRIVATE_KEY);
        walletAddress = signer.address;

        // Create temporary client to derive API credentials
        const tempClient = new ClobClient(env.POLYMARKET_CLOB_BASE_URL, CHAIN_ID, signer);

        // Derive API credentials (creates if not exists)
        const creds = await tempClient.createOrDeriveApiKey();

        // Store credentials for WebSocket auth
        apiCreds = {
            key: creds.key,
            secret: creds.secret,
            passphrase: creds.passphrase,
        };

        // Create authenticated client with credentials
        client = new ClobClient(env.POLYMARKET_CLOB_BASE_URL, CHAIN_ID, signer, creds);
        isInitialized = true;

        // Only log the address, never the key
        logger.info({ address: walletAddress }, "Initialized authenticated CLOB client");
        return true;
    } catch (err) {
        logger.error({ err }, "Failed to initialize CLOB client");
        return false;
    }
}

// ─── Unit Conversion ──────────────────────────────────────────────────────────

/**
 * Convert price micros (0..1_000_000) to decimal number for CLOB API.
 */
function priceMicrosToDecimal(micros: number): number {
    return micros / 1_000_000;
}

/**
 * Convert share micros to decimal number for CLOB API.
 */
function shareMicrosToDecimal(micros: bigint): number {
    return Number(micros) / 1_000_000;
}

/**
 * Convert USDC micros to decimal number for CLOB API.
 */
function usdcMicrosToDecimal(micros: bigint): number {
    return Number(micros) / 1_000_000;
}

/**
 * Convert decimal price string to micros.
 */
function decimalToPriceMicros(decimal: string): number {
    return Math.round(parseFloat(decimal) * 1_000_000);
}

/**
 * Convert decimal shares string to share micros.
 */
function decimalToShareMicros(decimal: string): bigint {
    return BigInt(Math.round(parseFloat(decimal) * 1_000_000));
}

// ─── Error Handling ───────────────────────────────────────────────────────────

/**
 * Normalize Polymarket error codes to our internal codes.
 */
function normalizeErrorCode(raw: string): string {
    const mapping: Record<string, string> = {
        INVALID_ORDER_MIN_SIZE: "LIVE_ORDER_REJECTED_MIN_SIZE",
        INVALID_ORDER_MIN_TICK_SIZE: "LIVE_ORDER_REJECTED_TICK_SIZE",
        INSUFFICIENT_BALANCE: "LIVE_ORDER_REJECTED_INSUFFICIENT_BALANCE",
        ORDER_REJECTED: "LIVE_ORDER_REJECTED_UNKNOWN",
        UNAUTHORIZED: "LIVE_ORDER_REJECTED_AUTH",
    };
    return mapping[raw] || `LIVE_ORDER_REJECTED_${raw}`;
}

/**
 * Check if an error is retryable (network issues, rate limits).
 */
function isRetryableError(code: string): boolean {
    const nonRetryable = ["INVALID_ORDER", "INSUFFICIENT", "UNAUTHORIZED", "REJECTED"];
    return !nonRetryable.some((prefix) => code.toUpperCase().includes(prefix));
}

/**
 * Map exchange order status to our internal status.
 */
function mapOrderStatus(status: string): ClobOrderStatus {
    const mapping: Record<string, ClobOrderStatus> = {
        LIVE: "LIVE",
        OPEN: "OPEN",
        MATCHED: "MATCHED",
        FILLED: "FILLED",
        CANCELLED: "CANCELED",
        CANCELED: "CANCELED",
        REJECTED: "REJECTED",
    };
    return mapping[status.toUpperCase()] || "OPEN";
}

// ─── Order Placement ──────────────────────────────────────────────────────────

/**
 * Place a FAK (Fill-And-Kill) order.
 *
 * FAK orders execute immediately against the order book:
 * - Any portion that can be filled is filled
 * - The remaining portion is canceled (not left on book)
 *
 * @param params Order parameters
 * @returns Result with clobOrderId on success, error details on failure
 */
export async function placeOrderFAK(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    if (!client || !isInitialized) {
        return {
            success: false,
            error: {
                code: "NOT_INITIALIZED",
                message: "CLOB client not initialized",
                isRetryable: false,
            },
        };
    }

    const log = logger.child({
        tokenId: params.tokenId,
        side: params.side,
        priceMicros: params.priceMicros,
        sizeShareMicros: params.sizeShareMicros.toString(),
    });

    try {
        log.debug("Placing FAK order");

        // UserMarketOrder.amount semantics (per clob-client):
        // - BUY: amount is USDC
        // - SELL: amount is shares
        const buyNotionalMicros =
            params.side === "BUY"
                ? (BigInt(params.priceMicros) * params.sizeShareMicros) / 1_000_000n
                : null;

        if (buyNotionalMicros !== null && buyNotionalMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
            return {
                success: false,
                error: {
                    code: "INVALID_SIZE",
                    message: "BUY notional too large for clob-client numeric amount conversion",
                    isRetryable: false,
                },
            };
        }

        if (params.sizeShareMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
            return {
                success: false,
                error: {
                    code: "INVALID_SIZE",
                    message: "SELL size too large for clob-client numeric amount conversion",
                    isRetryable: false,
                },
            };
        }

        const response = await client.createAndPostMarketOrder(
            {
                tokenID: params.tokenId,
                side: params.side === "BUY" ? Side.BUY : Side.SELL,
                price: priceMicrosToDecimal(params.priceMicros),
                amount:
                    params.side === "BUY"
                        ? usdcMicrosToDecimal(buyNotionalMicros!)
                        : shareMicrosToDecimal(params.sizeShareMicros),
            },
            undefined, // options
            OrderType.FAK
        );

        // Response structure varies; extract order ID
        const clobOrderId = response?.orderID || response?.id || response?.order_id;

        if (!clobOrderId) {
            log.error({ response }, "No order ID in response");
            return {
                success: false,
                error: {
                    code: "INVALID_RESPONSE",
                    message: "No order ID returned from exchange",
                    isRetryable: false,
                },
            };
        }

        const status = mapOrderStatus(response?.status || "OPEN");
        log.info({ clobOrderId, status }, "Placed FAK order");

        return {
            success: true,
            clobOrderId,
            status,
        };
    } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        const errorCode = error?.code || "UNKNOWN";
        const errorMessage = error?.message || String(err);

        log.error({ err, errorCode }, "Failed to place FAK order");

        return {
            success: false,
            error: {
                code: normalizeErrorCode(errorCode),
                message: errorMessage,
                isRetryable: isRetryableError(errorCode),
            },
        };
    }
}

// ─── Order Queries ────────────────────────────────────────────────────────────

/**
 * Get order by clobOrderId (for reconciliation).
 *
 * @param clobOrderId The exchange order ID
 * @returns Order info or null if not found
 */
export async function getOrder(clobOrderId: string): Promise<ClobOrder | null> {
    if (!client || !isInitialized) {
        logger.warn("getOrder called but client not initialized");
        return null;
    }

    const log = logger.child({ clobOrderId });

    try {
        const order = await client.getOrder(clobOrderId);

        if (!order) {
            log.debug("Order not found");
            return null;
        }

        return {
            clobOrderId: order.id,
            tokenId: order.asset_id,
            side: order.side.toUpperCase() === "BUY" ? "BUY" : "SELL",
            price: order.price,
            originalSize: order.original_size,
            filledSize: order.size_matched,
            status: mapOrderStatus(order.status),
            createdAt: order.created_at,
        };
    } catch (err) {
        log.error({ err }, "Failed to get order");
        return null;
    }
}

/**
 * List open orders (for SUBMISSION_UNKNOWN reconciliation).
 *
 * @returns Array of open orders
 */
export async function listOpenOrders(): Promise<ClobOrder[]> {
    if (!client || !isInitialized) {
        logger.warn("listOpenOrders called but client not initialized");
        return [];
    }

    try {
        const response = await client.getOpenOrders();

        // Response is an array of OpenOrder
        const orders = Array.isArray(response) ? response : [];

        return orders.map((order) => ({
            clobOrderId: order.id,
            tokenId: order.asset_id,
            side: order.side.toUpperCase() === "BUY" ? "BUY" : "SELL",
            price: order.price,
            originalSize: order.original_size,
            filledSize: order.size_matched,
            status: mapOrderStatus(order.status),
            createdAt: order.created_at,
        }));
    } catch (err) {
        logger.error({ err }, "Failed to list open orders");
        return [];
    }
}

/**
 * List recent trades for the authenticated wallet (for SUBMISSION_UNKNOWN resolution).
 *
 * Note: The upstream client exposes a paginated API. For reconciliation we only
 * need a small recent window, so we fetch only the first page.
 */
export async function listRecentTrades(params?: {
    asset_id?: string;
    market?: string;
    after?: string;
    before?: string;
}): Promise<ClobTrade[]> {
    if (!client || !isInitialized) {
        logger.warn("listRecentTrades called but client not initialized");
        return [];
    }

    try {
        const trades = await client.getTrades(params as any, true);
        const rows = Array.isArray(trades) ? trades : [];

        return rows.map((t: any) => {
            const makerOrderIds: string[] = Array.isArray(t.maker_orders)
                ? t.maker_orders
                      .map((m: any) => m?.order_id)
                      .filter((id: unknown): id is string => typeof id === "string")
                : [];

            const matchTimeMs = Date.parse(t.match_time);

            return {
                tradeId: String(t.id),
                tokenId: String(t.asset_id),
                side: String(t.side).toUpperCase() === "BUY" ? "BUY" : "SELL",
                status: String(t.status ?? ""),
                matchTimeMs: Number.isFinite(matchTimeMs) ? matchTimeMs : 0,
                traderSide:
                    t.trader_side === "TAKER" || t.trader_side === "MAKER"
                        ? t.trader_side
                        : "UNKNOWN",
                takerOrderId: typeof t.taker_order_id === "string" ? t.taker_order_id : null,
                makerOrderIds,
            } satisfies ClobTrade;
        });
    } catch (err) {
        logger.error({ err }, "Failed to list recent trades");
        return [];
    }
}

// ─── Account State ────────────────────────────────────────────────────────────

/**
 * Get cash/collateral balance.
 *
 * @returns Account balance in micros
 */
export async function getBalance(): Promise<AccountBalance | null> {
    if (!client || !isInitialized) {
        logger.warn("getBalance called but client not initialized");
        return null;
    }

    try {
        const response = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

        // Balance is returned as a decimal string (USDC with 6 decimals)
        // Convert to micros (which for USDC is 1:1 with the smallest unit)
        const balance = Number.parseFloat(response.balance);
        if (!Number.isFinite(balance)) {
            throw new Error(
                `Invalid balance response (balance=${String(response.balance)}, allowance=${String((response as any).allowance)})`
            );
        }

        const allowanceRaw = (response as any).allowance;
        const parsedAllowance =
            typeof allowanceRaw === "string" || typeof allowanceRaw === "number"
                ? Number.parseFloat(String(allowanceRaw))
                : Number.NaN;
        const allowance = Number.isFinite(parsedAllowance) ? parsedAllowance : balance;
        const spendable = Math.min(balance, allowance);

        const balanceMicros = BigInt(Math.round(spendable * 1_000_000));
        const allowanceMicros = BigInt(Math.round(allowance * 1_000_000));

        return {
            cashMicros: balanceMicros,
            allowanceMicros,
        };
    } catch (err) {
        logger.error({ err }, "Failed to get balance");
        return null;
    }
}

/**
 * Get positions.
 *
 * Note: The CLOB client may not directly support position queries.
 * If not available, returns null to indicate fallback to Data API is needed.
 *
 * @returns Array of positions or null if not supported
 */
export async function getPositions(): Promise<Position[] | null> {
    if (!client || !isInitialized) {
        logger.warn("getPositions called but client not initialized");
        return null;
    }

    // The CLOB client doesn't have a direct getPositions method.
    // Positions are typically fetched from the Data API.
    // Return null to indicate the caller should use the fallback.
    logger.debug("Positions not available via CLOB client, use Data API fallback");
    return null;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Cancel all open orders (emergency use).
 */
export async function cancelAllOrders(): Promise<boolean> {
    if (!client || !isInitialized) {
        logger.warn("cancelAllOrders called but client not initialized");
        return false;
    }

    try {
        await client.cancelAll();
        logger.info("Cancelled all open orders");
        return true;
    } catch (err) {
        logger.error({ err }, "Failed to cancel all orders");
        return false;
    }
}

/**
 * Cancel a specific order.
 *
 * @param clobOrderId The order to cancel
 */
export async function cancelOrder(clobOrderId: string): Promise<boolean> {
    if (!client || !isInitialized) {
        logger.warn("cancelOrder called but client not initialized");
        return false;
    }

    try {
        await client.cancelOrders([clobOrderId]);
        logger.info({ clobOrderId }, "Cancelled order");
        return true;
    } catch (err) {
        logger.error({ err, clobOrderId }, "Failed to cancel order");
        return false;
    }
}
