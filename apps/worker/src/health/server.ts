import { createServer, IncomingMessage, ServerResponse } from "http";
import { env } from "../config/env.js";
import { logger } from "../log/logger.js";
import { getQueueDepths } from "../queue/queues.js";
import { prisma } from "../db/prisma.js";
import { getAggregateStats } from "../reconcile/index.js";
import { getBookServiceStats } from "../simulate/bookService.js";
import { getGlobalConfig } from "../simulate/config.js";
import { getBufferStats } from "../simulate/smallTradeBuffer.js";
import type { SmallTradeNettingModeType } from "@copybot/shared";
import {
    isLiveClientInitialized,
    getReconciliationHealth,
    type ReconciliationHealth,
} from "../live/index.js";
import { getUserChannelMetrics, isUserChannelConnected } from "../live/userChannelWs.js";

interface LatencyMetrics {
    p50Ms: number;
    p95Ms: number;
    lastEventLagMs: number | null;
    sampleCount: number;
}

/**
 * v0.1: Simplified reconcile metrics.
 * Batching was removed since WS creates canonical trades directly.
 */
interface ReconcileMetrics {
    latency: LatencyMetrics;
}

/**
 * CLOB WebSocket book cache metrics.
 */
interface ClobBookMetrics {
    enabled: boolean;
    wsConnected: boolean;
    cacheSize: number;
    subscribedCount: number;
    freshCount: number;
}

/**
 * Small trade buffering config and state for health endpoint.
 */
interface SmallTradeBufferingHealth {
    enabled: boolean;
    notionalThresholdUsdc: number;
    flushMinNotionalUsdc: number;
    minExecNotionalUsdc: number;
    maxBufferMs: number;
    quietFlushMs: number;
    nettingMode: SmallTradeNettingModeType;
    // Live state
    activeBucketsCount: number;
    pendingNotionalTotalUsdc: number;
    // Metrics (since worker start)
    metrics: {
        bufferedTrades: number;
        immediateTrades: number;
        flushedBuckets: number;
        skippedFlushBelowMin: number;
        flushReasons: {
            threshold: number;
            quiet: number;
            maxTime: number;
            oppositeSide: number;
            shutdown: number;
        };
    };
}

/**
 * Live trading reconciliation health.
 */
interface LiveReconciliationHealth {
    enabled: boolean;
    isHealthy: boolean;
    isInitialized: boolean;
    lastOrderReconcileAt: string | null;
    lastStateReconcileAt: string | null;
    orderReconcileErrorCount: number;
    stateReconcileErrorCount: number;
    submissionUnknownCount: number;
    unresolvedOrderIds: string[];
}

interface UserChannelHealth {
    enabled: boolean;
    connected: boolean;
    lastConnectedAt: string | null;
    lastMessageAt: string | null;
    messageCount: number;
    orderUpdateCount: number;
    tradeUpdateCount: number;
    errorCount: number;
    orphanBufferSize: number;
}

interface HealthStatus {
    status: "ok" | "degraded" | "unhealthy";
    timestamp: string;
    lastCanonicalEventTime: string | null;
    alchemyWsConnected: boolean;
    clobBook: ClobBookMetrics;
    smallTradeBuffering: SmallTradeBufferingHealth;
    liveReconciliation: LiveReconciliationHealth;
    userChannel: UserChannelHealth;
    queueDepths: Record<string, number>;
    dbConnected: boolean;
    reconcile: ReconcileMetrics;
}

// Track Alchemy WS connection state (set by alchemy module)
let alchemyWsConnected = false;
export function setWsConnected(connected: boolean) {
    alchemyWsConnected = connected;
}
// Alias for clarity
export function setAlchemyWsConnected(connected: boolean) {
    alchemyWsConnected = connected;
}

// Track last canonical event time
let lastCanonicalEventTime: Date | null = null;
export function setLastCanonicalEventTime(time: Date) {
    lastCanonicalEventTime = time;
}

async function getHealthStatus(): Promise<HealthStatus> {
    let dbConnected = false;
    try {
        await prisma.$queryRaw`SELECT 1`;
        dbConnected = true;
    } catch {
        dbConnected = false;
    }

    const queueDepths = await getQueueDepths();

    // Get latency metrics
    const latencyStats = getAggregateStats();
    const reconcile: ReconcileMetrics = {
        latency: {
            p50Ms: latencyStats.totalLag.p50,
            p95Ms: latencyStats.totalLag.p95,
            lastEventLagMs: latencyStats.lastEventLagMs,
            sampleCount: latencyStats.count,
        },
    };

    // Get CLOB book metrics
    const bookStats = getBookServiceStats();
    const clobBook: ClobBookMetrics = {
        enabled: bookStats?.wsEnabled ?? false,
        wsConnected: bookStats?.wsConnected ?? false,
        cacheSize: bookStats?.cacheSize ?? 0,
        subscribedCount: bookStats?.subscribedCount ?? 0,
        freshCount: bookStats?.freshCount ?? 0,
    };

    // Get small trade buffering config and live stats
    const globalConfig = await getGlobalConfig();
    const bufferingConfig = globalConfig.smallTradeBuffering;
    const bufferStats = await getBufferStats();
    const smallTradeBuffering: SmallTradeBufferingHealth = {
        enabled: bufferingConfig.enabled,
        notionalThresholdUsdc: bufferingConfig.notionalThresholdMicros / 1_000_000,
        flushMinNotionalUsdc: bufferingConfig.flushMinNotionalMicros / 1_000_000,
        minExecNotionalUsdc: bufferingConfig.minExecNotionalMicros / 1_000_000,
        maxBufferMs: bufferingConfig.maxBufferMs,
        quietFlushMs: bufferingConfig.quietFlushMs,
        nettingMode: bufferingConfig.nettingMode,
        activeBucketsCount: bufferStats.activeBucketsCount,
        pendingNotionalTotalUsdc: Number(bufferStats.pendingNotionalTotalMicros) / 1_000_000,
        metrics: {
            bufferedTrades: bufferStats.metrics.bufferedTrades,
            immediateTrades: bufferStats.metrics.immediateTrades,
            flushedBuckets: bufferStats.metrics.flushedBuckets,
            skippedFlushBelowMin: bufferStats.metrics.skippedFlushBelowMin,
            flushReasons: {
                threshold: bufferStats.metrics.flushReasonThreshold,
                quiet: bufferStats.metrics.flushReasonQuiet,
                maxTime: bufferStats.metrics.flushReasonMaxTime,
                oppositeSide: bufferStats.metrics.flushReasonOppositeSide,
                shutdown: bufferStats.metrics.flushReasonShutdown,
            },
        },
    };

    // Get live trading reconciliation health
    const liveEnabled = isLiveClientInitialized();
    let liveReconciliation: LiveReconciliationHealth;
    let userChannel: UserChannelHealth;

    if (liveEnabled) {
        const reconHealth = getReconciliationHealth();
        liveReconciliation = {
            enabled: true,
            isHealthy: reconHealth.isHealthy,
            isInitialized: reconHealth.isInitialized,
            lastOrderReconcileAt: reconHealth.lastOrderReconcileAt?.toISOString() ?? null,
            lastStateReconcileAt: reconHealth.lastStateReconcileAt?.toISOString() ?? null,
            orderReconcileErrorCount: reconHealth.orderReconcileErrorCount,
            stateReconcileErrorCount: reconHealth.stateReconcileErrorCount,
            submissionUnknownCount: reconHealth.submissionUnknownCount,
            unresolvedOrderIds: reconHealth.unresolvedOrderIds,
        };

        const userMetrics = getUserChannelMetrics();
        userChannel = {
            enabled: true,
            connected: isUserChannelConnected(),
            lastConnectedAt: userMetrics.lastConnectedAt
                ? new Date(userMetrics.lastConnectedAt).toISOString()
                : null,
            lastMessageAt: userMetrics.lastMessageAt
                ? new Date(userMetrics.lastMessageAt).toISOString()
                : null,
            messageCount: userMetrics.messageCount,
            orderUpdateCount: userMetrics.orderUpdateCount,
            tradeUpdateCount: userMetrics.tradeUpdateCount,
            errorCount: userMetrics.errorCount,
            orphanBufferSize: userMetrics.orphanBufferSize,
        };
    } else {
        liveReconciliation = {
            enabled: false,
            isHealthy: true,
            isInitialized: false,
            lastOrderReconcileAt: null,
            lastStateReconcileAt: null,
            orderReconcileErrorCount: 0,
            stateReconcileErrorCount: 0,
            submissionUnknownCount: 0,
            unresolvedOrderIds: [],
        };

        userChannel = {
            enabled: false,
            connected: false,
            lastConnectedAt: null,
            lastMessageAt: null,
            messageCount: 0,
            orderUpdateCount: 0,
            tradeUpdateCount: 0,
            errorCount: 0,
            orphanBufferSize: 0,
        };
    }

    // Determine overall status
    let status: "ok" | "degraded" | "unhealthy" = "ok";
    if (!dbConnected) {
        status = "unhealthy";
    } else if (!alchemyWsConnected) {
        status = "degraded";
    } else if (liveEnabled && !liveReconciliation.isHealthy) {
        status = "degraded";
    }

    return {
        status,
        timestamp: new Date().toISOString(),
        lastCanonicalEventTime: lastCanonicalEventTime?.toISOString() ?? null,
        alchemyWsConnected,
        clobBook,
        smallTradeBuffering,
        liveReconciliation,
        userChannel,
        queueDepths,
        dbConnected,
        reconcile,
    };
}

function handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.url === "/health" && req.method === "GET") {
        getHealthStatus()
            .then((status) => {
                const statusCode = status.status === "unhealthy" ? 503 : 200;
                res.writeHead(statusCode, { "Content-Type": "application/json" });
                res.end(JSON.stringify(status));
            })
            .catch((err) => {
                logger.error({ err }, "Health check failed");
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "error", error: String(err) }));
            });
    } else {
        res.writeHead(404);
        res.end("Not Found");
    }
}

export function startHealthServer() {
    const server = createServer(handleRequest);
    server.listen(env.WORKER_PORT, () => {
        logger.info({ port: env.WORKER_PORT }, "Health server started");
    });
    return server;
}
