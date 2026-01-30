/**
 * Authenticated CLOB Client Wrapper.
 *
 * Provides authenticated order placement, order queries, and account state methods
 * for live trading using the official Polymarket TS client.
 *
 * Key responsibilities:
 * - Lazy singleton initialization with API key derivation
 * - Micros <-> decimal conversion (internal units <-> CLOB API units)
 * - Normalized error handling
 * - Type-safe wrappers around CLOB client methods
 */

import { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType, AssetType } from "@polymarket/clob-client";
import { createL2Headers } from "@polymarket/clob-client";
import type { OpenOrder, Trade, ApiKeyCreds } from "@polymarket/clob-client";
// Use @ethersproject/wallet (v5) since that's what @polymarket/clob-client expects
import { Wallet } from "@ethersproject/wallet";
import { env } from "../config/env.js";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "clob-client" });

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Polygon mainnet chain ID (hardcoded per spec) */
const CHAIN_ID = 137;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Order types supported for live trading */
export type ClobOrderType = "FAK" | "FOK" | "GTC";

/** Side for CLOB operations */
export type ClobSide = "BUY" | "SELL";

/** Status of a CLOB order (normalized from TS client) */
export type ClobOrderStatus =
    | "LIVE" // Open on exchange
    | "MATCHED" // Partially filled
    | "FILLED" // Completely filled (alias: CLOSED)
    | "CANCELED" // Canceled
    | "EXPIRED"; // Expired (GTC)

/** Order placement result */
export interface OrderPlacementResult {
    success: boolean;
    clobOrderId?: string;
    status?: ClobOrderStatus;
    errorCode?: string;
    errorMessage?: string;
}

/** Order info from exchange */
export interface ClobOrderInfo {
    orderId: string;
    tokenId: string;
    side: ClobSide;
    originalSizeShareMicros: bigint;
    filledSizeShareMicros: bigint;
    priceMicros: number;
    status: ClobOrderStatus;
    createdAt: Date;
}

/** Balance info */
export interface ClobBalance {
    cashAvailableMicros: bigint;
}

/** Position info */
export interface ClobPosition {
    tokenId: string;
    shareMicros: bigint;
}

/** Trade/fill info from exchange */
export interface ClobTrade {
    tradeId: string;
    orderId: string;
    tokenId: string;
    side: ClobSide;
    priceMicros: number;
    shareMicros: bigint;
    matchedAt: Date;
}

/** Known CLOB error codes */
export const ClobErrorCodes = {
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
    INVALID_TICK_SIZE: "INVALID_TICK_SIZE",
    INVALID_MIN_SIZE: "INVALID_MIN_SIZE",
    ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
    AUTH_FAILED: "AUTH_FAILED",
    RATE_LIMITED: "RATE_LIMITED",
    NOT_CONFIGURED: "NOT_CONFIGURED",
    NETWORK_ERROR: "NETWORK_ERROR",
    UNKNOWN: "UNKNOWN",
} as const;

export type ClobErrorCode = (typeof ClobErrorCodes)[keyof typeof ClobErrorCodes];

// -----------------------------------------------------------------------------
// Auth Helpers
// -----------------------------------------------------------------------------

/**
 * Create Polymarket L2 auth headers for a given request signature basis.
 *
 * Useful for authenticating non-REST channels (e.g. User Channel WebSocket),
 * where the server expects the same signed headers as REST.
 *
 * NOTE: This returns string header values (safe for WS libraries).
 */
export async function createL2AuthHeaders(args: {
    method: string;
    requestPath: string;
    body?: string;
}): Promise<Record<string, string>> {
    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    // Ensure client (and creds) are initialized.
    await getClient();
    if (!clientCreds) {
        throw new Error("CLOB client credentials not available");
    }

    const signer = new Wallet(requirePrivateKey());
    const headers = await createL2Headers(signer, clientCreds, {
        method: args.method,
        requestPath: args.requestPath,
        ...(args.body ? { body: args.body } : {}),
    });

    const stringHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        stringHeaders[key] = String(value);
    }
    return stringHeaders;
}

// -----------------------------------------------------------------------------
// Micros <-> Decimal Conversion
// -----------------------------------------------------------------------------

/**
 * Convert internal priceMicros to CLOB decimal number.
 * CLOB API expects price as a number (0-1 range).
 */
function priceMicrosToDecimal(priceMicros: number): number {
    return priceMicros / 1_000_000;
}

/**
 * Convert internal shareMicros to CLOB decimal number.
 * CLOB API expects size as a number.
 */
function shareMicrosToDecimal(shareMicros: bigint): number {
    return Number(shareMicros) / 1_000_000;
}

/**
 * Convert CLOB decimal price string to priceMicros.
 */
function decimalToPriceMicros(decimal: string | number): number {
    const value = typeof decimal === "string" ? parseFloat(decimal) : decimal;
    return Math.round(value * 1_000_000);
}

/**
 * Convert CLOB decimal shares string to shareMicros.
 */
function decimalToShareMicros(decimal: string | number): bigint {
    const value = typeof decimal === "string" ? parseFloat(decimal) : decimal;
    return BigInt(Math.round(value * 1_000_000));
}

/**
 * Convert our ClobSide to the CLOB client Side enum.
 */
function toClientSide(side: ClobSide): Side {
    return side === "BUY" ? Side.BUY : Side.SELL;
}

/**
 * Convert CLOB client side to our ClobSide type.
 */
function fromClientSide(side: Side | string): ClobSide {
    return side === Side.BUY || side === "BUY" ? "BUY" : "SELL";
}

/**
 * Normalize CLOB order status string to our ClobOrderStatus type.
 */
function normalizeOrderStatus(status: string): ClobOrderStatus {
    const upper = status.toUpperCase();
    switch (upper) {
        case "LIVE":
        case "OPEN":
            return "LIVE";
        case "MATCHED":
        case "PARTIAL":
            return "MATCHED";
        case "FILLED":
        case "CLOSED":
            return "FILLED";
        case "CANCELED":
        case "CANCELLED":
            return "CANCELED";
        case "EXPIRED":
            return "EXPIRED";
        default:
            logger.warn({ status }, "Unknown CLOB order status, defaulting to LIVE");
            return "LIVE";
    }
}

// -----------------------------------------------------------------------------
// Error Handling
// -----------------------------------------------------------------------------

/**
 * Normalize CLOB client errors into structured error info.
 */
function normalizeError(err: unknown): { code: ClobErrorCode; message: string } {
    const message = err instanceof Error ? err.message : String(err);
    const lowerMsg = message.toLowerCase();

    // Map known error patterns to codes
    if (lowerMsg.includes("insufficient") || lowerMsg.includes("not enough")) {
        return { code: ClobErrorCodes.INSUFFICIENT_BALANCE, message };
    }
    if (lowerMsg.includes("tick") || lowerMsg.includes("price increment")) {
        return { code: ClobErrorCodes.INVALID_TICK_SIZE, message };
    }
    if (
        (lowerMsg.includes("min") && lowerMsg.includes("size")) ||
        lowerMsg.includes("minimum order")
    ) {
        return { code: ClobErrorCodes.INVALID_MIN_SIZE, message };
    }
    if (lowerMsg.includes("not found") || lowerMsg.includes("order does not exist")) {
        return { code: ClobErrorCodes.ORDER_NOT_FOUND, message };
    }
    if (lowerMsg.includes("auth") || lowerMsg.includes("unauthorized") || lowerMsg.includes("403")) {
        return { code: ClobErrorCodes.AUTH_FAILED, message };
    }
    if (lowerMsg.includes("rate") || lowerMsg.includes("429") || lowerMsg.includes("too many")) {
        return { code: ClobErrorCodes.RATE_LIMITED, message };
    }
    if (
        lowerMsg.includes("network") ||
        lowerMsg.includes("econnrefused") ||
        lowerMsg.includes("timeout")
    ) {
        return { code: ClobErrorCodes.NETWORK_ERROR, message };
    }

    return { code: ClobErrorCodes.UNKNOWN, message };
}

// -----------------------------------------------------------------------------
// Client Initialization (Lazy Singleton)
// -----------------------------------------------------------------------------

let clientInstance: ClobClient | null = null;
let clientCreds: ApiKeyCreds | null = null;
let initializationPromise: Promise<ClobClient> | null = null;

/**
 * Require the private key env var, throwing if not configured.
 */
function requirePrivateKey(): string {
    if (!env.POLYMARKET_LIVE_PRIVATE_KEY) {
        throw new Error("POLYMARKET_LIVE_PRIVATE_KEY not configured - cannot initialize CLOB client");
    }
    return env.POLYMARKET_LIVE_PRIVATE_KEY;
}

/**
 * Initialize the CLOB client with API key derivation.
 */
async function initializeClient(): Promise<ClobClient> {
    const privateKey = requirePrivateKey();
    const signer = new Wallet(privateKey);

    logger.info("Initializing CLOB client and deriving API credentials...");

    try {
        // Create temporary client to derive/create API key
        const tempClient = new ClobClient(env.POLYMARKET_CLOB_BASE_URL, CHAIN_ID, signer);
        const creds = await tempClient.createOrDeriveApiKey();

        // Store credentials for reference
        clientCreds = creds;

        // Create authenticated client with derived credentials
        const client = new ClobClient(env.POLYMARKET_CLOB_BASE_URL, CHAIN_ID, signer, creds);

        logger.info("CLOB client initialized successfully");
        return client;
    } catch (err) {
        const normalized = normalizeError(err);
        logger.error({ err, errorCode: normalized.code }, "Failed to initialize CLOB client");
        throw err;
    }
}

/**
 * Get the initialized CLOB client (lazy singleton).
 */
async function getClient(): Promise<ClobClient> {
    if (clientInstance) return clientInstance;

    if (!initializationPromise) {
        initializationPromise = initializeClient()
            .then((client) => {
                clientInstance = client;
                return client;
            })
            .catch((err) => {
                initializationPromise = null;
                throw err;
            });
    }

    return initializationPromise;
}

/**
 * Check if CLOB client can be initialized (private key available).
 */
export function isLiveClientConfigured(): boolean {
    return !!env.POLYMARKET_LIVE_PRIVATE_KEY;
}

/**
 * Reset client (for testing or credential rotation).
 * Forces re-initialization on next use.
 */
export function resetClient(): void {
    clientInstance = null;
    clientCreds = null;
    initializationPromise = null;
    logger.debug("CLOB client reset");
}

/**
 * Get the wallet address associated with the CLOB client.
 * Returns null if not configured.
 */
export function getWalletAddress(): string | null {
    if (!env.POLYMARKET_LIVE_PRIVATE_KEY) return null;
    try {
        const signer = new Wallet(env.POLYMARKET_LIVE_PRIVATE_KEY);
        return signer.address;
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// Order Placement
// -----------------------------------------------------------------------------

/**
 * Place a FAK (Fill-and-Kill) order.
 *
 * FAK orders fill immediately against available liquidity.
 * Any unfilled portion is immediately canceled.
 * This is the default order type for copy trading.
 */
export async function createOrderFAK(params: {
    tokenId: string;
    side: ClobSide;
    priceMicros: number;
    sizeShareMicros: bigint;
}): Promise<OrderPlacementResult> {
    const log = logger.child({
        tokenId: params.tokenId,
        side: params.side,
        priceMicros: params.priceMicros,
        sizeShareMicros: params.sizeShareMicros.toString(),
    });

    if (!isLiveClientConfigured()) {
        return {
            success: false,
            errorCode: ClobErrorCodes.NOT_CONFIGURED,
            errorMessage: "CLOB client not configured",
        };
    }

    try {
        const client = await getClient();

        // Convert to CLOB API units
        const price = priceMicrosToDecimal(params.priceMicros);
        const size = shareMicrosToDecimal(params.sizeShareMicros);

        log.info({ price, size }, "Placing FAK order");

        // Post a limit order using share sizing for BOTH BUY and SELL.
        // Using createAndPostMarketOrder is unsafe here because BUY "amount"
        // is denominated in USDC (not shares).
        const order = await client.createOrder({
            tokenID: params.tokenId,
            price,
            size,
            side: toClientSide(params.side),
        });
        const response = await client.postOrder(order, OrderType.FAK, false, false);

        log.info({ response }, "FAK order response");

        // Parse response
        if (response?.success === false || response?.errorMsg) {
            const errorNormalized = normalizeError(new Error(response.errorMsg || "Order failed"));
            return {
                success: false,
                errorCode: errorNormalized.code,
                errorMessage: response.errorMsg || "Order placement failed",
            };
        }

        // Extract order ID - the response structure varies
        const orderId = response?.orderID || response?.orderIds?.[0] || response?.order_id;
        const status = response?.status ? normalizeOrderStatus(response.status) : "LIVE";

        return {
            success: true,
            clobOrderId: orderId,
            status,
        };
    } catch (err) {
        const normalized = normalizeError(err);
        log.error({ err, errorCode: normalized.code }, "FAK order placement failed");
        return {
            success: false,
            errorCode: normalized.code,
            errorMessage: normalized.message,
        };
    }
}

/**
 * Place a FOK (Fill-or-Kill) order.
 *
 * FOK orders must be filled entirely or not at all.
 * Useful for reconciliation corrections where partial fills are undesirable.
 */
export async function createOrderFOK(params: {
    tokenId: string;
    side: ClobSide;
    priceMicros: number;
    sizeShareMicros: bigint;
}): Promise<OrderPlacementResult> {
    const log = logger.child({
        tokenId: params.tokenId,
        side: params.side,
        priceMicros: params.priceMicros,
        sizeShareMicros: params.sizeShareMicros.toString(),
    });

    if (!isLiveClientConfigured()) {
        return {
            success: false,
            errorCode: ClobErrorCodes.NOT_CONFIGURED,
            errorMessage: "CLOB client not configured",
        };
    }

    try {
        const client = await getClient();

        // Convert to CLOB API units
        const price = priceMicrosToDecimal(params.priceMicros);
        const size = shareMicrosToDecimal(params.sizeShareMicros);

        log.info({ price, size }, "Placing FOK order");

        const order = await client.createOrder({
            tokenID: params.tokenId,
            price,
            size,
            side: toClientSide(params.side),
        });
        const response = await client.postOrder(order, OrderType.FOK, false, false);

        log.info({ response }, "FOK order response");

        if (response?.success === false || response?.errorMsg) {
            const errorNormalized = normalizeError(new Error(response.errorMsg || "Order failed"));
            return {
                success: false,
                errorCode: errorNormalized.code,
                errorMessage: response.errorMsg || "Order placement failed",
            };
        }

        const orderId = response?.orderID || response?.orderIds?.[0] || response?.order_id;
        const status = response?.status ? normalizeOrderStatus(response.status) : "LIVE";

        return {
            success: true,
            clobOrderId: orderId,
            status,
        };
    } catch (err) {
        const normalized = normalizeError(err);
        log.error({ err, errorCode: normalized.code }, "FOK order placement failed");
        return {
            success: false,
            errorCode: normalized.code,
            errorMessage: normalized.message,
        };
    }
}

// -----------------------------------------------------------------------------
// Order Queries
// -----------------------------------------------------------------------------

/**
 * Convert OpenOrder from CLOB client to our ClobOrderInfo type.
 */
function openOrderToInfo(order: OpenOrder): ClobOrderInfo {
    return {
        orderId: order.id,
        tokenId: order.asset_id,
        side: fromClientSide(order.side),
        originalSizeShareMicros: decimalToShareMicros(order.original_size),
        filledSizeShareMicros: decimalToShareMicros(order.size_matched),
        priceMicros: decimalToPriceMicros(order.price),
        status: normalizeOrderStatus(order.status),
        createdAt: new Date(order.created_at * 1000), // created_at is Unix timestamp
    };
}

/**
 * Get order status by clobOrderId.
 *
 * Used for reconciliation and lifecycle tracking.
 * Returns null if order not found.
 */
export async function getOrder(clobOrderId: string): Promise<ClobOrderInfo | null> {
    const log = logger.child({ clobOrderId });

    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    try {
        const client = await getClient();
        const order = await client.getOrder(clobOrderId);

        if (!order) {
            log.debug("Order not found");
            return null;
        }

        const info = openOrderToInfo(order);
        log.debug({ info }, "Retrieved order info");
        return info;
    } catch (err) {
        const normalized = normalizeError(err);
        if (normalized.code === ClobErrorCodes.ORDER_NOT_FOUND) {
            log.debug("Order not found");
            return null;
        }
        log.error({ err, errorCode: normalized.code }, "Failed to get order");
        throw err;
    }
}

/**
 * List all open orders for the wallet.
 *
 * Used for SUBMISSION_UNKNOWN reconciliation.
 * Returns only non-final orders (LIVE, MATCHED).
 */
export async function listOpenOrders(): Promise<ClobOrderInfo[]> {
    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    try {
        const client = await getClient();
        const orders = await client.getOpenOrders();

        const infos = orders.map(openOrderToInfo);
        logger.debug({ count: infos.length }, "Listed open orders");
        return infos;
    } catch (err) {
        const normalized = normalizeError(err);
        logger.error({ err, errorCode: normalized.code }, "Failed to list open orders");
        throw err;
    }
}

/**
 * Cancel an order by clobOrderId.
 *
 * Returns true if canceled successfully or already canceled/filled.
 */
export async function cancelOrder(clobOrderId: string): Promise<boolean> {
    const log = logger.child({ clobOrderId });

    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    try {
        const client = await getClient();
        await client.cancelOrder({ orderID: clobOrderId });

        log.info("Order canceled");
        return true;
    } catch (err) {
        const normalized = normalizeError(err);

        // If order not found or already canceled/filled, treat as success
        if (normalized.code === ClobErrorCodes.ORDER_NOT_FOUND) {
            log.debug("Order not found (may already be finalized)");
            return true;
        }

        log.error({ err, errorCode: normalized.code }, "Failed to cancel order");
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Account State
// -----------------------------------------------------------------------------

/**
 * Get available cash (USDC collateral) balance.
 *
 * This is the source of truth for BUY affordability checks.
 */
export async function getBalance(): Promise<ClobBalance> {
    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    try {
        const client = await getClient();
        const response = await client.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        });

        const cashAvailableMicros = decimalToShareMicros(response.balance);
        logger.debug({ cashAvailableMicros: cashAvailableMicros.toString() }, "Retrieved balance");

        return { cashAvailableMicros };
    } catch (err) {
        const normalized = normalizeError(err);
        logger.error({ err, errorCode: normalized.code }, "Failed to get balance");
        throw err;
    }
}

/**
 * Get positions (share holdings by token).
 *
 * NOTE: The CLOB client may not directly support fetching all positions.
 * This method will throw if not supported - callers should use the Data API
 * fallback in reconciliation (Step 9).
 *
 * For now, we provide a stub that indicates positions must be fetched
 * via another mechanism.
 */
export async function getPositions(): Promise<ClobPosition[]> {
    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    // The CLOB client doesn't have a direct "get all positions" endpoint.
    // Positions need to be fetched via:
    // 1. The Data API (recommended for reconciliation)
    // 2. Individual token balance queries
    //
    // For MVP, we throw to indicate this should use the fallback path.
    throw new Error(
        "getPositions() not supported via CLOB client - use Data API fallback in reconciliation"
    );
}

/**
 * Get position for a specific token.
 *
 * Returns the share balance for a single conditional token.
 */
export async function getPositionForToken(tokenId: string): Promise<ClobPosition | null> {
    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    try {
        const client = await getClient();
        const response = await client.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        });

        const shareMicros = decimalToShareMicros(response.balance);

        if (shareMicros === 0n) {
            return null;
        }

        logger.debug(
            { tokenId, shareMicros: shareMicros.toString() },
            "Retrieved position for token"
        );

        return { tokenId, shareMicros };
    } catch (err) {
        const normalized = normalizeError(err);
        logger.error({ err, errorCode: normalized.code, tokenId }, "Failed to get position for token");
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Trades / Fills
// -----------------------------------------------------------------------------

/**
 * Get recent trades for the wallet.
 *
 * Used for reconciliation to match fills.
 */
export async function getTrades(params?: {
    tokenId?: string;
    after?: Date;
    before?: Date;
}): Promise<ClobTrade[]> {
    if (!isLiveClientConfigured()) {
        throw new Error("CLOB client not configured");
    }

    try {
        const client = await getClient();

        const tradeParams: { asset_id?: string; after?: string; before?: string } = {};
        if (params?.tokenId) {
            tradeParams.asset_id = params.tokenId;
        }
        if (params?.after) {
            tradeParams.after = params.after.toISOString();
        }
        if (params?.before) {
            tradeParams.before = params.before.toISOString();
        }

        const trades = await client.getTrades(tradeParams);

        const result: ClobTrade[] = trades.map((trade: Trade) => ({
            tradeId: trade.id,
            orderId: trade.taker_order_id,
            tokenId: trade.asset_id,
            side: fromClientSide(trade.side),
            priceMicros: decimalToPriceMicros(trade.price),
            shareMicros: decimalToShareMicros(trade.size),
            matchedAt: new Date(trade.match_time),
        }));

        logger.debug({ count: result.length }, "Retrieved trades");
        return result;
    } catch (err) {
        const normalized = normalizeError(err);
        logger.error({ err, errorCode: normalized.code }, "Failed to get trades");
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Health / Status
// -----------------------------------------------------------------------------

/**
 * Check if the CLOB client is healthy (can connect and authenticate).
 */
export async function checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    if (!isLiveClientConfigured()) {
        return { healthy: false, error: "CLOB client not configured" };
    }

    try {
        const client = await getClient();
        await client.getOk();
        return { healthy: true };
    } catch (err) {
        const normalized = normalizeError(err);
        return { healthy: false, error: normalized.message };
    }
}
