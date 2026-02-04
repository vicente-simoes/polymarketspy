import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../log/logger.js";

// Shared Redis connection for health checks and other direct usage
export const redisConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) => {
    logger.error({ err }, "Redis connection error");
});

redisConnection.on("connect", () => {
    logger.info("Redis connected");
});

// Queue names (locked per planning.md)
export const QUEUE_NAMES = {
    INGEST_EVENTS: "q_ingest_events",
    GROUP_EVENTS: "q_group_events",
    COPY_ATTEMPT_USER: "q_copy_attempt_user",
    COPY_ATTEMPT_GLOBAL: "q_copy_attempt_global",
    COPY_ATTEMPT_LIVE: "q_copy_attempt_live",
    RECONCILE: "q_reconcile",
    PRICES: "q_prices",
} as const;

// Default job options with retries and backoff
export const defaultJobOptions = {
    attempts: 3,
    backoff: {
        type: "exponential" as const,
        delay: 1000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
};

// Parse Redis URL for BullMQ connection config (avoids ioredis version mismatch)
function parseRedisUrl(url: string) {
    const parsed = new URL(url);
    return {
        host: parsed.hostname,
        port: parseInt(parsed.port || "6379", 10),
        password: parsed.password || undefined,
    };
}

const redisConfig = parseRedisUrl(env.REDIS_URL);

// Create a queue with default options
export function createQueue(name: string) {
    return new Queue(name, {
        connection: redisConfig,
        defaultJobOptions,
    });
}

// Create a worker with logging
export function createWorker<T>(
    name: string,
    processor: (job: { data: T; id?: string }) => Promise<void>,
    options?: { concurrency?: number }
) {
    const defaultConcurrencyByQueue: Partial<Record<(typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES], number>> =
        {
            [QUEUE_NAMES.INGEST_EVENTS]: env.WORKER_CONCURRENCY_INGEST ?? 2,
            [QUEUE_NAMES.GROUP_EVENTS]: env.WORKER_CONCURRENCY_GROUP ?? 1,
            [QUEUE_NAMES.COPY_ATTEMPT_GLOBAL]: env.WORKER_CONCURRENCY_COPY_GLOBAL ?? 1,
            [QUEUE_NAMES.COPY_ATTEMPT_LIVE]: 1, // Serialized per wallet for safety
            [QUEUE_NAMES.RECONCILE]: env.WORKER_CONCURRENCY_RECONCILE ?? 1,
            [QUEUE_NAMES.PRICES]: env.WORKER_CONCURRENCY_PRICES ?? 1,
        };

    const resolvedConcurrency =
        typeof options?.concurrency === "number"
            ? options.concurrency
            : defaultConcurrencyByQueue[name as (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]] ??
              env.WORKER_CONCURRENCY_DEFAULT;

    const worker = new Worker<T>(
        name,
        async (job) => {
            const log = logger.child({ queue: name, jobId: job.id });
            log.debug({ data: job.data }, "Processing job");
            try {
                await processor(job);
                log.debug("Job completed");
            } catch (err) {
                log.error({ err }, "Job failed");
                throw err;
            }
        },
        {
            connection: redisConfig,
            concurrency: resolvedConcurrency,
        }
    );

    logger.info({ queue: name, concurrency: resolvedConcurrency }, "BullMQ worker started");

    worker.on("failed", (job, err) => {
        logger.error({ queue: name, jobId: job?.id, err }, "Job permanently failed (DLQ)");
    });

    return worker;
}

// Initialize all queues
export const queues = {
    ingestEvents: createQueue(QUEUE_NAMES.INGEST_EVENTS),
    groupEvents: createQueue(QUEUE_NAMES.GROUP_EVENTS),
    copyAttemptUser: createQueue(QUEUE_NAMES.COPY_ATTEMPT_USER),
    copyAttemptGlobal: createQueue(QUEUE_NAMES.COPY_ATTEMPT_GLOBAL),
    copyAttemptLive: createQueue(QUEUE_NAMES.COPY_ATTEMPT_LIVE),
    reconcile: createQueue(QUEUE_NAMES.RECONCILE),
    prices: createQueue(QUEUE_NAMES.PRICES),
};

// Get queue depths for health check
export async function getQueueDepths(): Promise<Record<string, number>> {
    const depths: Record<string, number> = {};
    for (const [key, queue] of Object.entries(queues)) {
        const counts = await queue.getJobCounts();
        depths[key] = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    }
    return depths;
}
