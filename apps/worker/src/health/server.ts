import { createServer, IncomingMessage, ServerResponse } from "http";
import { env } from "../config/env.js";
import { logger } from "../log/logger.js";
import { getQueueDepths } from "../queue/queues.js";
import { prisma } from "../db/prisma.js";
import { getAggregateStats, getPendingBatchCount, getPendingEventCount } from "../reconcile/index.js";

interface LatencyMetrics {
    p50Ms: number;
    p95Ms: number;
    lastEventLagMs: number | null;
    sampleCount: number;
}

interface ReconcileMetrics {
    pendingBatches: number;
    pendingEvents: number;
    latency: LatencyMetrics;
}

interface HealthStatus {
    status: "ok" | "degraded" | "unhealthy";
    timestamp: string;
    lastCanonicalEventTime: string | null;
    wsConnected: boolean;
    queueDepths: Record<string, number>;
    dbConnected: boolean;
    reconcile: ReconcileMetrics;
}

// Track WS connection state (set by alchemy module)
let wsConnected = false;
export function setWsConnected(connected: boolean) {
    wsConnected = connected;
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

    // Get reconcile/latency metrics
    const latencyStats = getAggregateStats();
    const reconcile: ReconcileMetrics = {
        pendingBatches: getPendingBatchCount(),
        pendingEvents: getPendingEventCount(),
        latency: {
            p50Ms: latencyStats.totalLag.p50,
            p95Ms: latencyStats.totalLag.p95,
            lastEventLagMs: latencyStats.lastEventLagMs,
            sampleCount: latencyStats.count,
        },
    };

    // Determine overall status
    let status: "ok" | "degraded" | "unhealthy" = "ok";
    if (!dbConnected) {
        status = "unhealthy";
    } else if (!wsConnected) {
        status = "degraded";
    }

    return {
        status,
        timestamp: new Date().toISOString(),
        lastCanonicalEventTime: lastCanonicalEventTime?.toISOString() ?? null,
        wsConnected,
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
