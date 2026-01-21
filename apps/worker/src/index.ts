import { logger } from "./log/logger.js";
import { prisma } from "./db/prisma.js";
import { startHealthServer } from "./health/server.js";
import { redisConnection } from "./queue/queues.js";
import { startPolling, stopPolling } from "./ingest/index.js";
import { startPortfolioWorkers } from "./portfolio/index.js";
import { startAlchemySubscription, stopAlchemySubscription, setAlchemyRedisClient } from "./alchemy/index.js";
import { startGroupEventsWorker, startCopyAttemptWorkers, flushAllGroups } from "./simulate/index.js";
import { startSnapshotLoops, stopSnapshotLoops } from "./snapshot/index.js";
import { startReconcileWorker, stopReconcileWorker, flushPendingReconciles } from "./reconcile/index.js";
import { startEnrichmentProcessor, stopEnrichmentProcessor } from "./enrichment/index.js";
import { loadResolvedTokensFromRedis, setRedisClient } from "./poly/index.js";
import { stopBookService } from "./simulate/bookService.js";
import { env } from "./config/env.js";
import { startSettlementLoop, stopSettlementLoop } from "./settlement.js";

async function main() {
    logger.info("Worker starting...");

    // Verify database connection
    try {
        await prisma.$connect();
        logger.info("Database connected");
    } catch (err) {
        logger.fatal({ err }, "Failed to connect to database");
        process.exit(1);
    }

    // Verify Redis connection
    try {
        await redisConnection.ping();
        logger.info("Redis connected");
    } catch (err) {
        logger.fatal({ err }, "Failed to connect to Redis");
        process.exit(1);
    }

    // Set up resolved token cache with Redis persistence
    setRedisClient(redisConnection);
    await loadResolvedTokensFromRedis(redisConnection);

    // Set up Alchemy rate limit persistence
    setAlchemyRedisClient(redisConnection);

    // Start health server
    startHealthServer();

    // Start ingestion polling
    await startPolling();

    // Start portfolio workers (shadow ledger processing)
    startPortfolioWorkers();

    // Start aggregation worker (event grouping)
    startGroupEventsWorker();

    // Start copy attempt workers (executable simulation)
    startCopyAttemptWorkers();

    // Start Alchemy WebSocket subscription (non-canonical trigger)
    // Can be disabled via ALCHEMY_WS_ENABLED=false for development
    if (env.ALCHEMY_WS_ENABLED) {
        await startAlchemySubscription();
    } else {
        logger.info("Alchemy WebSocket disabled (ALCHEMY_WS_ENABLED=false)");
    }

    // Log CLOB Book WS status (lazily initialized on first book request)
    if (env.CLOB_BOOK_WS_ENABLED) {
        logger.info("CLOB Book WebSocket enabled (will connect on first book request)");
    } else {
        logger.info("CLOB Book WebSocket disabled (CLOB_BOOK_WS_ENABLED=false), using REST only");
    }

    // Start reconcile worker (processes Alchemy-triggered fast fetches)
    startReconcileWorker();

    // Start enrichment processor (async metadata enrichment for WS-first trades)
    startEnrichmentProcessor();

    // Start snapshot loops (price refresh every 30s, portfolio snapshots every minute)
    startSnapshotLoops();

    // Start settlement loop (closes resolved positions and credits payout)
    startSettlementLoop();

    logger.info("Worker started successfully");

    // Graceful shutdown
    const shutdown = async () => {
        logger.info("Shutting down...");
        stopPolling();
        stopSnapshotLoops();
        stopSettlementLoop();
        stopEnrichmentProcessor();
        await flushAllGroups(); // Flush any pending aggregation groups
        await flushPendingReconciles(); // Flush any pending reconcile batches
        await stopReconcileWorker();
        if (env.ALCHEMY_WS_ENABLED) {
            await stopAlchemySubscription();
        }
        // Stop CLOB book WebSocket and cache
        await stopBookService();
        await prisma.$disconnect();
        await redisConnection.quit();
        process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

main().catch((err) => {
    logger.fatal({ err }, "Worker crashed");
    process.exit(1);
});
