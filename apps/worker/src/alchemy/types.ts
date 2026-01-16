/**
 * Alchemy WebSocket types and constants for Polymarket fill event monitoring.
 *
 * This module defines the contract addresses and event signatures needed to
 * subscribe to on-chain fill events via Alchemy WebSocket.
 *
 * v0.1: WS-first architecture - on-chain events are now CANONICAL.
 * Polymarket Data API is used for enrichment (market metadata) only.
 */

/**
 * Polymarket Exchange contracts on Polygon.
 *
 * NOTE:
 * - Legacy CTF Exchange: older/standard markets
 * - Neg Risk CTF Exchange: multi-outcome / neg-risk markets (your example tx uses this)
 */
export const LEGACY_CTF_EXCHANGE_ADDRESS =
  "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

export const NEG_RISK_CTF_EXCHANGE_ADDRESS =
  "0xC5d563A36AE78145C45a50134d48A1215220f80a";

/**
 * Always subscribe to both to avoid missing fills.
 */
export const CTF_EXCHANGE_ADDRESSES: string[] = [
  LEGACY_CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
];

/**
 * OrderFilled event signature from the CTF Exchange contract.
 *
 * Event: OrderFilled(
 *   bytes32 indexed orderHash,
 *   address indexed maker,
 *   address indexed taker,
 *   uint256 makerAssetId,
 *   uint256 takerAssetId,
 *   uint256 makerAmountFilled,
 *   uint256 takerAmountFilled,
 *   uint256 fee
 * )
 */
export const ORDER_FILLED_TOPIC =
    "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";

/**
 * Convert a 20-byte Ethereum address to 32-byte H256 format for topic filtering.
 * Topic filters require addresses to be zero-padded to 32 bytes.
 *
 * Example: 0x44236223aB4291b93EEd10E4B511B37a398DEE55
 *       -> 0x00000000000000000000000044236223ab4291b93eed10e4b511b37a398dee55
 */
export function toH256Address(address: string): string {
    // Remove 0x prefix, lowercase, then pad to 64 hex chars (32 bytes)
    return "0x" + address.slice(2).toLowerCase().padStart(64, "0");
}

/**
 * Raw log event from the WebSocket subscription.
 */
export interface RawLogEvent {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string; // hex
    transactionHash: string;
    transactionIndex: string; // hex
    blockHash: string;
    logIndex: string; // hex
    removed: boolean;
}

/**
 * Parsed fill event data from an OrderFilled log.
 */
export interface ParsedFillEvent {
    txHash: string;
    logIndex: number;
    blockNumber: number;
    orderHash: string;
    maker: string;
    taker: string;
    makerAssetId: bigint;
    takerAssetId: bigint;
    makerAmountFilled: bigint;
    takerAmountFilled: bigint;
    fee: bigint;
    removed: boolean;
}

/**
 * Reconcile job payload for the q_reconcile queue.
 *
 * v0.1: Simplified - only used for safety-net backfills.
 * - alchemy_reconnect: Backfill after WS reconnection (5 minutes)
 * - periodic: Safety net backfill (2 minutes)
 *
 * Note: Primary trade detection now happens via WS subscription
 * which creates canonical trades directly (no reconcile needed).
 */
export interface ReconcileJobData {
    reason: "alchemy_reconnect" | "periodic";
    backfillMinutes?: number;
    triggeredAt: string;
}

// ============================================================================
// WS-first canonical trade types (v0.1)
// ============================================================================

/**
 * Collateral decimals for Polymarket (USDCe on Polygon).
 * Outcome tokens use the same base units as collateral (1:1 split).
 * Future-proofing: this could be made configurable per chain/market.
 */
export const COLLATERAL_DECIMALS = 6;

/**
 * In OrderFilled events, assetId == 0 represents USDC (collateral).
 * The non-zero assetId is the outcome token.
 */
export const USDC_ASSET_ID = 0n;

/**
 * Role of the followed wallet in an OrderFilled event.
 */
export type FillRole = "MAKER" | "TAKER";

/**
 * Fully decoded and derived OrderFilled event ready for DB insertion.
 * Contains all fields needed to create a canonical TradeEvent.
 */
export interface DecodedOrderFilled {
    // === From raw log ===
    txHash: string;
    logIndex: number;
    blockNumber: number;
    exchangeAddress: string;

    // === Raw event fields ===
    orderHash: string;
    maker: string;
    taker: string;
    makerAssetId: bigint;
    takerAssetId: bigint;
    makerAmountFilled: bigint;
    takerAmountFilled: bigint;
    fee: bigint;

    // === Derived fields ===
    /** The outcome token ID (non-USDC assetId, as string for DB storage) */
    outcomeTokenId: string;
    /** USDC amount in micros (6 decimals) */
    usdcAmountMicros: bigint;
    /** Token amount in micros (6 decimals) */
    tokenAmountMicros: bigint;
    /** The tracked wallet address involved in this fill */
    followedWallet: string;
    /** Whether followed wallet is the proxy (true) or profile wallet (false) */
    isProxy: boolean;
    /** The profile wallet address (may differ from followedWallet if proxy) */
    profileWallet: string;
    /** Role of followed wallet in this fill */
    role: FillRole;
    /** Trade side from followed wallet's perspective */
    side: "BUY" | "SELL";
    /** Price in micros (0..1_000_000) */
    priceMicros: number;
    /** Notional (USDC) in micros */
    notionalMicros: bigint;
    /** Shares (tokens) in micros */
    shareMicros: bigint;
    /** Fee in micros (paid by maker of this order) */
    feeMicros: bigint;

    // === Timestamps ===
    /** When the WS event was detected */
    detectTime: Date;
}
