import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "checkpoint" });

/**
 * Get checkpoint value for a key.
 */
export async function getCheckpoint<T>(key: string): Promise<T | null> {
    const checkpoint = await prisma.systemCheckpoint.findUnique({
        where: { key },
    });

    if (!checkpoint) {
        return null;
    }

    return checkpoint.valueJson as T;
}

/**
 * Set checkpoint value for a key.
 */
export async function setCheckpoint<T>(key: string, value: T): Promise<void> {
    await prisma.systemCheckpoint.upsert({
        where: { key },
        create: {
            key,
            valueJson: value as object,
        },
        update: {
            valueJson: value as object,
        },
    });
    logger.debug({ key }, "Checkpoint saved");
}

export async function deleteCheckpoint(key: string): Promise<void> {
    await prisma.systemCheckpoint.deleteMany({ where: { key } });
    logger.debug({ key }, "Checkpoint deleted");
}

/**
 * Get last trade time checkpoint for a followed user.
 */
export async function getLastTradeTime(userId: string): Promise<Date | null> {
    const value = await getCheckpoint<{ timestamp: string }>(
        `api:lastTradeTime:${userId}`
    );
    return value ? new Date(value.timestamp) : null;
}

/**
 * Set last trade time checkpoint for a followed user.
 */
export async function setLastTradeTime(userId: string, time: Date): Promise<void> {
    await setCheckpoint(`api:lastTradeTime:${userId}`, {
        timestamp: time.toISOString(),
    });
}

export type ApiTimePaginationCursor = {
    afterSeconds: number;
    beforeSeconds?: number;
    maxSeenSeconds?: number;
    updatedAt: string;
};

export async function getTradeIngestCursor(
    userId: string
): Promise<ApiTimePaginationCursor | null> {
    return getCheckpoint<ApiTimePaginationCursor>(`api:tradeIngestCursor:${userId}`);
}

export async function setTradeIngestCursor(
    userId: string,
    cursor: ApiTimePaginationCursor
): Promise<void> {
    await setCheckpoint(`api:tradeIngestCursor:${userId}`, cursor);
}

export async function clearTradeIngestCursor(userId: string): Promise<void> {
    await deleteCheckpoint(`api:tradeIngestCursor:${userId}`);
}

/**
 * Get last activity time checkpoint for a followed user.
 */
export async function getLastActivityTime(userId: string): Promise<Date | null> {
    const value = await getCheckpoint<{ timestamp: string }>(
        `api:lastActivityTime:${userId}`
    );
    return value ? new Date(value.timestamp) : null;
}

/**
 * Set last activity time checkpoint for a followed user.
 */
export async function setLastActivityTime(userId: string, time: Date): Promise<void> {
    await setCheckpoint(`api:lastActivityTime:${userId}`, {
        timestamp: time.toISOString(),
    });
}

export async function getActivityIngestCursor(
    userId: string
): Promise<ApiTimePaginationCursor | null> {
    return getCheckpoint<ApiTimePaginationCursor>(`api:activityIngestCursor:${userId}`);
}

export async function setActivityIngestCursor(
    userId: string,
    cursor: ApiTimePaginationCursor
): Promise<void> {
    await setCheckpoint(`api:activityIngestCursor:${userId}`, cursor);
}

export async function clearActivityIngestCursor(userId: string): Promise<void> {
    await deleteCheckpoint(`api:activityIngestCursor:${userId}`);
}
