/**
 * Alchemy WebSocket subscription for low-latency fill event detection.
 *
 * This module subscribes to on-chain OrderFilled events from the Polymarket
 * CTF Exchange contract. These events are NOT canonical - they serve only as
 * triggers for fast reconciliation via the Polymarket Data API.
 *
 * Behavior:
 * - One WebSocket connection to Alchemy
 * - One logs subscription filtered by contract address + event topic
 * - On event: insert non-canonical TradeEvent and enqueue reconcile
 * - On disconnect: reconnect with exponential backoff
 * - On reconnect: enqueue reconcile for last 5 minutes
 */

import { WebSocketProvider, AbiCoder, getAddress } from "ethers";
import WebSocket from "ws";
import { TradeSide, Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { queues } from "../queue/queues.js";
import { setWsConnected } from "../health/server.js";
import { getLastBlock, setLastBlock } from "./checkpoint.js";
import {
    CTF_EXCHANGE_ADDRESS,
    ORDER_FILLED_TOPIC,
    type RawLogEvent,
    type ParsedFillEvent,
    type ReconcileJobData,
} from "./types.js";

const logger = createChildLogger({ module: "alchemy-ws" });

type TrackedWalletInfo = {
    profileWallet: string;
    isProxy: boolean;
};

const TRACKED_WALLET_CACHE_TTL_MS = 60_000;
let trackedWalletsCache = new Map<string, TrackedWalletInfo>();
let trackedWalletsLoadedAt = 0;
let trackedWalletsLoadPromise: Promise<Map<string, TrackedWalletInfo>> | null = null;

const normalizeWallet = (wallet: string | null | undefined) =>
    wallet ? wallet.toLowerCase() : null;

async function loadTrackedWallets(): Promise<Map<string, TrackedWalletInfo>> {
    const [users, proxies] = await Promise.all([
        prisma.followedUser.findMany({
            select: { profileWallet: true },
        }),
        prisma.followedUserProxyWallet.findMany({
            select: {
                wallet: true,
                followedUser: { select: { profileWallet: true } },
            },
        }),
    ]);

    const next = new Map<string, TrackedWalletInfo>();

    for (const user of users) {
        const normalized = normalizeWallet(user.profileWallet);
        if (!normalized) continue;
        next.set(normalized, {
            profileWallet: user.profileWallet,
            isProxy: false,
        });
    }

    for (const proxy of proxies) {
        const normalized = normalizeWallet(proxy.wallet);
        const profileWallet = proxy.followedUser?.profileWallet ?? null;
        if (!normalized || !profileWallet) continue;
        next.set(normalized, {
            profileWallet,
            isProxy: true,
        });
    }

    trackedWalletsCache = next;
    trackedWalletsLoadedAt = Date.now();
    return trackedWalletsCache;
}

async function getTrackedWallets(): Promise<Map<string, TrackedWalletInfo>> {
    const now = Date.now();
    if (now - trackedWalletsLoadedAt < TRACKED_WALLET_CACHE_TTL_MS) {
        return trackedWalletsCache;
    }

    if (!trackedWalletsLoadPromise) {
        trackedWalletsLoadPromise = loadTrackedWallets().finally(() => {
            trackedWalletsLoadPromise = null;
        });
    }

    return trackedWalletsLoadPromise;
}

// Reconnection constants
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const BACKOFF_MULTIPLIER = 2;

// Reconcile backfill window on reconnect (per spec: 5 minutes)
const RECONNECT_BACKFILL_MINUTES = 5;

// Module state
let provider: WebSocketProvider | null = null;
let subscriptionId: string | null = null;
let isRunning = false;
let currentBackoffMs = INITIAL_BACKOFF_MS;
let reconnectTimeout: NodeJS.Timeout | null = null;

/**
 * Parse a raw log event into a structured fill event.
 */
function parseLogEvent(log: RawLogEvent): ParsedFillEvent {
    // Indexed topics: orderHash (topic1), maker (topic2), taker (topic3)
    const orderHash = log.topics[1]!;
    const maker = getAddress("0x" + log.topics[2]!.slice(26)); // Last 20 bytes
    const taker = getAddress("0x" + log.topics[3]!.slice(26));

    // Non-indexed data: makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee
    const abiCoder = AbiCoder.defaultAbiCoder();
    const decoded = abiCoder.decode(
        ["uint256", "uint256", "uint256", "uint256", "uint256"],
        log.data
    );

    return {
        txHash: log.transactionHash,
        logIndex: parseInt(log.logIndex, 16),
        blockNumber: parseInt(log.blockNumber, 16),
        orderHash,
        maker,
        taker,
        makerAssetId: decoded[0] as bigint,
        takerAssetId: decoded[1] as bigint,
        makerAmountFilled: decoded[2] as bigint,
        takerAmountFilled: decoded[3] as bigint,
        fee: decoded[4] as bigint,
        removed: log.removed,
    };
}

interface AlchemyInsertResult {
    isNew: boolean;
    profileWallet: string | null;
}

/**
 * Insert a non-canonical TradeEvent from an on-chain fill.
 * Returns whether the event was new and the matched profile wallet.
 */
async function insertAlchemyTradeEvent(event: ParsedFillEvent): Promise<AlchemyInsertResult> {
    const log = logger.child({ txHash: event.txHash, logIndex: event.logIndex });

    const trackedWallets = await getTrackedWallets();
    const makerKey = normalizeWallet(event.maker);
    const takerKey = normalizeWallet(event.taker);
    const makerInfo = makerKey ? trackedWallets.get(makerKey) : undefined;
    const takerInfo = takerKey ? trackedWallets.get(takerKey) : undefined;

    if (!makerInfo && !takerInfo) {
        return { isNew: false, profileWallet: null };
    }

    let matchedInfo = makerInfo ?? takerInfo;
    let matchedWallet = makerInfo ? event.maker : event.taker;

    if (makerInfo && takerInfo && makerInfo.isProxy && !takerInfo.isProxy) {
        matchedInfo = takerInfo;
        matchedWallet = event.taker;
    }

    const profileWallet = matchedInfo!.profileWallet;
    const proxyWallet = matchedInfo!.isProxy ? matchedWallet : null;

    // Skip removed/reorged events
    if (event.removed) {
        log.debug("Skipping removed event (reorg)");
        return { isNew: false, profileWallet };
    }

    // Check if already exists by txHash + logIndex
    const existing = await prisma.tradeEvent.findFirst({
        where: {
            txHash: event.txHash,
            logIndex: event.logIndex,
        },
    });

    if (existing) {
        log.debug("Event already exists, skipping");
        return { isNew: false, profileWallet };
    }

    // Determine side: if maker is receiving the asset, they're buying
    // The maker receives takerAssetId and gives makerAssetId
    // In Polymarket CTF: one side is always USDC (collateral)
    // If takerAssetId is USDC, maker is selling outcome tokens
    // If makerAssetId is USDC, maker is buying outcome tokens
    // Without knowing which is USDC, we'll store as BUY (reconcile will fix)
    const side = TradeSide.BUY;

    // Store amounts as micros (6 decimals)
    // Note: actual price calculation requires knowing which is the outcome token
    // For now, store raw values - canonical reconcile will provide accurate data
    const shareMicros = event.makerAmountFilled;
    const notionalMicros = event.takerAmountFilled;

    // Price in micros (0..1_000_000) - rough estimate
    // Actual price = notional / shares, but we need to know decimals
    // Setting to 0 as this is non-canonical - reconcile provides real values
    const priceMicros = 0;

    try {
        await prisma.tradeEvent.create({
            data: {
                source: "ALCHEMY",
                sourceId: null, // Alchemy events don't have a source ID
                txHash: event.txHash,
                logIndex: event.logIndex,
                isCanonical: false,
                profileWallet,
                proxyWallet,
                marketId: null, // Not available from on-chain event
                assetId: event.makerAssetId.toString(), // Store as string
                side,
                priceMicros,
                shareMicros,
                notionalMicros,
                feeMicros: event.fee,
                eventTime: new Date(), // Block timestamp not available, use detect time
                detectTime: new Date(),
            },
        });

        log.info({ profileWallet, proxyWallet }, "Inserted Alchemy trade event");
        return { isNew: true, profileWallet };
    } catch (err) {
        // Handle unique constraint violations gracefully
        if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
        ) {
            log.debug("Event already exists (constraint)");
            return { isNew: false, profileWallet };
        }
        throw err;
    }
}

/**
 * Enqueue a reconcile job to verify and process the event canonically.
 */
async function enqueueReconcile(data: ReconcileJobData): Promise<void> {
    await queues.reconcile.add("reconcile", data, {
        // Deduplicate by txHash for event-triggered reconciles
        // Note: BullMQ doesn't allow colons in job IDs, using underscore separator
        jobId: data.txHash ? `reconcile_${data.txHash}` : undefined,
    });
    logger.debug({ reason: data.reason }, "Enqueued reconcile job");
}

/**
 * Handle a received log event from the WebSocket subscription.
 */
async function handleLogEvent(log: RawLogEvent): Promise<void> {
    const eventLogger = logger.child({ txHash: log.transactionHash });

    try {
        const parsed = parseLogEvent(log);
        eventLogger.debug({ blockNumber: parsed.blockNumber }, "Received fill event");

        // Insert non-canonical event
        const result = await insertAlchemyTradeEvent(parsed);

        // Update checkpoint
        await setLastBlock(parsed.blockNumber);

        // Enqueue reconcile if this is a new event for a tracked wallet
        if (result.isNew && result.profileWallet) {
            await enqueueReconcile({
                reason: "alchemy_event",
                txHash: parsed.txHash,
                walletAddress: result.profileWallet,
                triggeredAt: new Date().toISOString(),
            });
        }
    } catch (err) {
        eventLogger.error({ err }, "Failed to process log event");
    }
}

/**
 * Set up the eth_subscribe logs subscription.
 */
async function setupSubscription(): Promise<void> {
    if (!provider) {
        throw new Error("Provider not initialized");
    }

    const filter = {
        address: CTF_EXCHANGE_ADDRESS,
        topics: [ORDER_FILLED_TOPIC],
    };

    logger.info({ filter }, "Setting up logs subscription");

    // ethers v6 doesn't have direct eth_subscribe for logs
    // We use provider.on("log", ...) which internally subscribes
    provider.on(filter, async (log) => {
        // The log from ethers is already parsed, we need the raw format
        // Convert ethers Log to our RawLogEvent format
        const rawLog: RawLogEvent = {
            address: log.address,
            topics: [...log.topics],
            data: log.data,
            blockNumber: "0x" + log.blockNumber.toString(16),
            transactionHash: log.transactionHash,
            transactionIndex: "0x" + log.transactionIndex.toString(16),
            blockHash: log.blockHash,
            logIndex: "0x" + log.index.toString(16),
            removed: log.removed,
        };
        await handleLogEvent(rawLog);
    });

    logger.info("Logs subscription active");
}

/**
 * Create a WebSocket connection with proper error handling.
 * This creates the WebSocket FIRST with error handlers attached,
 * preventing unhandled 'error' events from crashing Node.js.
 */
function createWebSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let ws: WebSocket | null = null;

        const settle = (fn: () => void) => {
            if (!settled) {
                settled = true;
                fn();
            }
        };

        const onError = (err: Error) => {
            settle(() => {
                if (ws) {
                    ws.removeAllListeners();
                    ws.close();
                }
                reject(err);
            });
        };

        const onOpen = () => {
            settle(() => {
                ws!.removeListener("error", onError);
                ws!.removeListener("open", onOpen);
                resolve(ws!);
            });
        };

        // Create WebSocket with error handler attached immediately
        ws = new WebSocket(url);
        ws.on("error", onError);
        ws.on("open", onOpen);

        // Connection timeout
        setTimeout(() => {
            settle(() => {
                if (ws) {
                    ws.removeAllListeners();
                    ws.close();
                }
                reject(new Error("WebSocket connection timeout after 30s"));
            });
        }, 30000);
    });
}

/**
 * Create a WebSocketProvider with proper error handling.
 * The ws library emits 'error' on the WebSocket during HTTP upgrade failures (like 429),
 * which must be caught to prevent crashing Node.js.
 */
async function createProvider(url: string): Promise<WebSocketProvider> {
    // First create the WebSocket with proper error handling
    const ws = await createWebSocket(url);

    // Now create the provider using the established WebSocket
    // ethers v6 accepts a WebSocket instance
    const newProvider = new WebSocketProvider(ws as unknown as globalThis.WebSocket);

    // Wait for provider to be ready
    await newProvider.ready;

    return newProvider;
}

/**
 * Connect to Alchemy WebSocket and set up subscriptions.
 */
async function connect(): Promise<void> {
    logger.info("Connecting to Alchemy WebSocket...");

    try {
        const newProvider = await createProvider(env.ALCHEMY_WS_URL);

        provider = newProvider;
        logger.info("WebSocket connected");
        setWsConnected(true);
        currentBackoffMs = INITIAL_BACKOFF_MS; // Reset backoff on successful connect

        // Add error handler for runtime errors
        provider.on("error", (err: Error) => {
            logger.error({ err: err.message }, "Provider error");
            if (isRunning && provider === newProvider) {
                handleDisconnect();
            }
        });

        // Set up subscription
        await setupSubscription();

        // Monitor connection by checking network periodically
        // The provider will throw when connection is lost
        const monitorConnection = async () => {
            if (!isRunning || !provider || provider !== newProvider) return;

            try {
                await provider.getNetwork();
                // Connection still alive, check again later
                setTimeout(monitorConnection, 30000);
            } catch {
                logger.warn("WebSocket disconnected (network check failed)");
                handleDisconnect();
            }
        };

        // Start monitoring after a brief delay
        setTimeout(monitorConnection, 30000);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Check for rate limiting
        if (errorMessage.includes("429")) {
            logger.warn({ err: errorMessage }, "Alchemy rate limited (429), will retry with backoff");
        } else {
            logger.error({ err: errorMessage }, "Failed to connect to Alchemy WebSocket");
        }

        setWsConnected(false);

        // Clean up any partially created provider
        if (provider) {
            try {
                provider.removeAllListeners();
                await provider.destroy();
            } catch {
                // Ignore cleanup errors
            }
            provider = null;
        }

        if (isRunning) {
            scheduleReconnect();
        }
    }
}

/**
 * Handle disconnection from WebSocket.
 */
function handleDisconnect(): void {
    setWsConnected(false);
    subscriptionId = null;
    if (provider) {
        provider.removeAllListeners();
        provider = null;
    }

    if (isRunning) {
        scheduleReconnect();
    }
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(): void {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    logger.info({ backoffMs: currentBackoffMs }, "Scheduling reconnect");

    reconnectTimeout = setTimeout(async () => {
        reconnectTimeout = null;
        await reconnect();
    }, currentBackoffMs);

    // Increase backoff for next attempt
    currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
}

/**
 * Reconnect to WebSocket and trigger reconciliation.
 */
async function reconnect(): Promise<void> {
    logger.info("Attempting reconnection...");

    await connect();

    // On successful reconnect, enqueue reconcile for last 5 minutes
    if (provider) {
        await enqueueReconcile({
            reason: "alchemy_reconnect",
            backfillMinutes: RECONNECT_BACKFILL_MINUTES,
            triggeredAt: new Date().toISOString(),
        });
    }
}

/**
 * Start the Alchemy WebSocket subscription.
 */
export async function startAlchemySubscription(): Promise<void> {
    if (isRunning) {
        logger.warn("Alchemy subscription already running");
        return;
    }

    isRunning = true;
    logger.info("Starting Alchemy WebSocket subscription");

    // Log last known block
    const lastBlock = await getLastBlock();
    if (lastBlock) {
        logger.info({ lastBlock }, "Resuming from last known block");
    }

    await connect();
}

/**
 * Stop the Alchemy WebSocket subscription.
 */
export async function stopAlchemySubscription(): Promise<void> {
    isRunning = false;

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (provider) {
        provider.removeAllListeners();
        await provider.destroy();
        provider = null;
    }

    setWsConnected(false);
    logger.info("Alchemy WebSocket subscription stopped");
}
