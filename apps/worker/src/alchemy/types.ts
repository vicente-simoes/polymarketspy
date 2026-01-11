/**
 * Alchemy WebSocket types and constants for Polymarket fill event monitoring.
 *
 * This module defines the contract addresses and event signatures needed to
 * subscribe to on-chain fill events via Alchemy WebSocket.
 *
 * IMPORTANT: This is NOT canonical data. It's used only as a trigger for
 * fast reconciliation. The Polymarket Data API remains the source of truth.
 */

/**
 * Polymarket CTF Exchange contract address on Polygon.
 * This is the V2 exchange contract where all fills occur.
 */
export const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

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
 */
export interface ReconcileJobData {
    reason: "alchemy_event" | "alchemy_reconnect" | "periodic";
    txHash?: string;
    walletAddress?: string;
    backfillMinutes?: number;
    triggeredAt: string;
}
