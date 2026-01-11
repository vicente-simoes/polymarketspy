import { logger } from "./log/logger.js";
import { prisma } from "./db/prisma.js";
import { startHealthServer } from "./health/server.js";
import { redisConnection } from "./queue/queues.js";
import { startPolling, stopPolling } from "./ingest/index.js";
import { startPortfolioWorkers } from "./portfolio/index.js";

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

    // Start health server
    startHealthServer();

    // Start ingestion polling
    await startPolling();

    // Start portfolio workers (shadow ledger, aggregation)
    startPortfolioWorkers();

    // TODO: Start Alchemy WebSocket subscription
    // TODO: Start price refresh loop

    logger.info("Worker started successfully");

    // Graceful shutdown
    const shutdown = async () => {
        logger.info("Shutting down...");
        stopPolling();
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
