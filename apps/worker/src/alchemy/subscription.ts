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
    toH256Address,
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
const MAX_BACKOFF_MS = 300_000; // 5 minutes max for normal errors
const MAX_RATE_LIMIT_BACKOFF_MS = 600_000; // 10 minutes max for rate limits
const BACKOFF_MULTIPLIER = 2;
const INITIAL_RATE_LIMIT_BACKOFF_MS = 120_000; // Start with 2 minutes on rate limit

// Track consecutive rate limits for progressive backoff
let consecutiveRateLimits = 0;

// Reconcile backfill window on reconnect (per spec: 5 minutes)
const RECONNECT_BACKFILL_MINUTES = 5;

// Redis key for persisting rate limit state across restarts
const RATE_LIMIT_REDIS_KEY = "alchemy:rate_limit_until";

// Module state
let provider: WebSocketProvider | null = null;
let subscriptionId: string | null = null;
let isRunning = false;
let currentBackoffMs = INITIAL_BACKOFF_MS;
let reconnectTimeout: NodeJS.Timeout | null = null;

// Subscription filtering state
let subscribedWalletHash: string | null = null;
const RESUBSCRIBE_CHECK_INTERVAL_MS = 60_000; // Align with cache TTL
let resubscribeInterval: NodeJS.Timeout | null = null;

/**
 * Create a hash of the wallet list for change detection.
 */
function hashWalletList(wallets: string[]): string {
    return wallets.sort().join(",");
}

// Redis client reference (set via setAlchemyRedisClient)
// Using generic interface compatible with ioredis
interface RedisLike {
    get(key: string): Promise<string | null>;
    setex(key: string, seconds: number, value: string): Promise<string>;
}

let redisClient: RedisLike | null = null;

/**
 * Set the Redis client for persisting rate limit state.
 */
export function setAlchemyRedisClient(redis: RedisLike): void {
    redisClient = redis;
}

/**
 * Check if we're still within a rate limit backoff period.
 * Returns the remaining wait time in ms, or 0 if we can connect.
 */
async function getRateLimitWaitMs(): Promise<number> {
    if (!redisClient) return 0;
    try {
        const untilStr = await redisClient.get(RATE_LIMIT_REDIS_KEY);
        if (!untilStr) return 0;
        const until = parseInt(untilStr, 10);
        const remaining = until - Date.now();
        return remaining > 0 ? remaining : 0;
    } catch {
        return 0;
    }
}

/**
 * Save rate limit backoff to Redis so it persists across restarts.
 */
async function saveRateLimitBackoff(backoffMs: number): Promise<void> {
    if (!redisClient) return;
    try {
        const until = Date.now() + backoffMs;
        const ttlSeconds = Math.ceil(backoffMs / 1000) + 10;
        // Use setex for atomic set-with-expiry
        await redisClient.setex(RATE_LIMIT_REDIS_KEY, ttlSeconds, until.toString());
    } catch {
        // Ignore Redis errors for non-critical persistence
    }
}

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
 * Log event handler callback for provider.on().
 * Converts ethers Log format to our RawLogEvent format.
 */
async function handleLogCallback(log: {
    address: string;
    topics: readonly string[];
    data: string;
    blockNumber: number;
    transactionHash: string;
    transactionIndex: number;
    blockHash: string;
    index: number;
    removed: boolean;
}): Promise<void> {
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
}

/**
 * Set up the eth_subscribe logs subscription filtered by tracked wallets.
 *
 * Uses topic filtering to only receive OrderFilled events where the
 * maker OR taker is a tracked wallet. This significantly reduces
 * bandwidth and compute unit consumption on Alchemy.
 *
 * Since topic positions use AND logic, we need two subscriptions:
 * 1. Filter by maker in tracked wallets
 * 2. Filter by taker in tracked wallets
 *
 * Duplicates (when both maker AND taker are tracked) are handled by
 * existing deduplication logic (txHash + logIndex unique).
 */
async function setupSubscription(): Promise<void> {
    if (!provider) {
        throw new Error("Provider not initialized");
    }

    const trackedWallets = await getTrackedWallets();
    const walletAddresses = Array.from(trackedWallets.keys());

    if (walletAddresses.length === 0) {
        // No wallets to track - don't subscribe (saves bandwidth)
        logger.info("No tracked wallets, skipping Alchemy subscription");
        subscribedWalletHash = "";
        return;
    }

    // Pad addresses to H256 format for topic filtering
    const paddedAddresses = walletAddresses.map(toH256Address);
    subscribedWalletHash = hashWalletList(walletAddresses);

    logger.info(
        { walletCount: walletAddresses.length },
        "Setting up filtered logs subscription"
    );

    // Filter 1: maker (topics[2]) is a tracked wallet
    const makerFilter = {
        address: CTF_EXCHANGE_ADDRESS,
        topics: [ORDER_FILLED_TOPIC, null, paddedAddresses, null],
    };

    // Filter 2: taker (topics[3]) is a tracked wallet
    const takerFilter = {
        address: CTF_EXCHANGE_ADDRESS,
        topics: [ORDER_FILLED_TOPIC, null, null, paddedAddresses],
    };

    provider.on(makerFilter, handleLogCallback);
    provider.on(takerFilter, handleLogCallback);

    logger.info("Filtered logs subscription active");
}

/**
 * Check if tracked wallets have changed and resubscribe if needed.
 * Called periodically to detect new wallets added via the web UI.
 */
async function checkAndResubscribe(): Promise<void> {
    if (!provider || !isRunning) return;

    try {
        const trackedWallets = await getTrackedWallets();
        const walletAddresses = Array.from(trackedWallets.keys());
        const newHash = hashWalletList(walletAddresses);

        if (newHash !== subscribedWalletHash) {
            const oldCount = subscribedWalletHash?.split(",").filter(Boolean).length ?? 0;
            logger.info(
                { oldCount, newCount: walletAddresses.length },
                "Tracked wallets changed, resubscribing"
            );
            provider.removeAllListeners();
            await setupSubscription();
        }
    } catch (err) {
        logger.error({ err }, "Error checking for wallet changes");
    }
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
 *
 * Note: We use staticNetwork to prevent ethers from making initialization RPC calls.
 * Per Alchemy docs, WebSocket connections should be used exclusively for eth_subscribe/eth_unsubscribe.
 */
async function createProvider(url: string): Promise<WebSocketProvider> {
    // First create the WebSocket with proper error handling
    const ws = await createWebSocket(url);

    // Create provider with staticNetwork to prevent initialization RPC calls
    // Polygon mainnet chainId is 137
    const newProvider = new WebSocketProvider(
        ws as unknown as globalThis.WebSocket,
        { chainId: 137, name: "matic" },  // Static network - no RPC calls
        { staticNetwork: true }
    );

    return newProvider;
}

/**
 * Connect to Alchemy WebSocket and set up subscriptions.
 */
async function connect(): Promise<void> {
    // Log URL format (without exposing API key)
    const urlParts = env.ALCHEMY_WS_URL.split("/");
    const maskedUrl = urlParts.length > 3
        ? `${urlParts.slice(0, 3).join("/")}/${urlParts[3]?.slice(0, 4)}...`
        : "invalid-url-format";
    logger.info({ urlFormat: maskedUrl, protocol: urlParts[0] }, "Connecting to Alchemy WebSocket...");

    try {
        const newProvider = await createProvider(env.ALCHEMY_WS_URL);

        provider = newProvider;
        logger.info("WebSocket connected");
        setWsConnected(true);
        // Reset backoff on successful connection
        currentBackoffMs = INITIAL_BACKOFF_MS;
        consecutiveRateLimits = 0;

        // Add error handler for runtime errors
        provider.on("error", (err: Error) => {
            logger.error({ err: err.message }, "Provider error");
            if (isRunning && provider === newProvider) {
                handleDisconnect().catch((disconnectErr) => {
                    logger.error({ err: disconnectErr }, "Error during disconnect handling");
                });
            }
        });

        // Set up subscription
        await setupSubscription();

        // Start periodic check for wallet changes
        if (resubscribeInterval) {
            clearInterval(resubscribeInterval);
        }
        resubscribeInterval = setInterval(() => {
            checkAndResubscribe().catch((err) => {
                logger.error({ err }, "Unhandled error in resubscribe check");
            });
        }, RESUBSCRIBE_CHECK_INTERVAL_MS);

        // Note: We do NOT use getNetwork() for health checks.
        // Per Alchemy docs, WebSocket should only be used for eth_subscribe/eth_unsubscribe.
        // Connection health is monitored via WebSocket close/error events instead.
        logger.debug("Connection monitoring via WebSocket events (no RPC polling)");
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Check for rate limiting
        if (errorMessage.includes("429")) {
            consecutiveRateLimits++;
            // Progressive backoff: 2min, 4min, 8min, capped at 10min
            const rateLimitBackoff = Math.min(
                INITIAL_RATE_LIMIT_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveRateLimits - 1),
                MAX_RATE_LIMIT_BACKOFF_MS
            );
            const backoffMinutes = Math.ceil(rateLimitBackoff / 60000);
            logger.warn(
                { err: errorMessage, consecutiveRateLimits, backoffMinutes },
                `Alchemy rate limited (429), backing off ${backoffMinutes} minutes`
            );
            currentBackoffMs = rateLimitBackoff;
            // Persist to Redis so restarts respect the backoff
            await saveRateLimitBackoff(rateLimitBackoff);
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
async function handleDisconnect(): Promise<void> {
    setWsConnected(false);
    subscriptionId = null;
    subscribedWalletHash = null;

    // Clear resubscribe interval
    if (resubscribeInterval) {
        clearInterval(resubscribeInterval);
        resubscribeInterval = null;
    }

    // Properly destroy the provider to close the WebSocket connection
    if (provider) {
        provider.removeAllListeners();
        try {
            await provider.destroy();
        } catch (err) {
            logger.debug({ err }, "Error destroying provider during disconnect");
        }
        provider = null;
    }

    if (isRunning) {
        scheduleReconnect();
    }
}

/**
 * Schedule a reconnection attempt with exponential backoff and jitter.
 */
function scheduleReconnect(): void {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    // Add jitter: ±10% of backoff to prevent thundering herd
    const jitter = currentBackoffMs * 0.1 * (Math.random() - 0.5);
    const actualBackoff = Math.floor(currentBackoffMs + jitter);
    const backoffSeconds = Math.ceil(actualBackoff / 1000);

    logger.info({ backoffMs: actualBackoff, backoffSeconds }, "Scheduling reconnect");

    reconnectTimeout = setTimeout(async () => {
        reconnectTimeout = null;
        await reconnect();
    }, actualBackoff);

    // Only increase backoff for non-rate-limit errors
    // Rate limit backoff is calculated based on consecutiveRateLimits in connect()
    if (consecutiveRateLimits === 0) {
        currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    }
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

    // Check if we're still in a rate limit backoff from a previous run
    const waitMs = await getRateLimitWaitMs();
    if (waitMs > 0) {
        logger.info(
            { waitMs, waitSec: Math.ceil(waitMs / 1000) },
            "Respecting rate limit backoff from previous run"
        );
        currentBackoffMs = waitMs;
        scheduleReconnect();
        return;
    }

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

    if (resubscribeInterval) {
        clearInterval(resubscribeInterval);
        resubscribeInterval = null;
    }

    subscribedWalletHash = null;

    if (provider) {
        provider.removeAllListeners();
        await provider.destroy();
        provider = null;
    }

    setWsConnected(false);
    logger.info("Alchemy WebSocket subscription stopped");
}
