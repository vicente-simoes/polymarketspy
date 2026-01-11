import { ActivityType, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    fetchWalletActivity,
    sharesToMicros,
    usdcToMicros,
    type PolymarketActivity,
    type ActivityPayload,
} from "../poly/index.js";
import { getLastActivityTime, setLastActivityTime } from "./checkpoint.js";
import { queues } from "../queue/queues.js";

const logger = createChildLogger({ module: "activity-ingester" });

/**
 * Source identifier for Polymarket API activity events.
 */
const SOURCE = "POLYMARKET_API";

/**
 * Map API activity type to DB enum.
 */
function mapActivityType(type: string): ActivityType {
    switch (type) {
        case "MERGE":
            return ActivityType.MERGE;
        case "SPLIT":
            return ActivityType.SPLIT;
        case "REDEEM":
            return ActivityType.REDEEM;
        default:
            throw new Error(`Unknown activity type: ${type}`);
    }
}

/**
 * Convert API activity to database insert data.
 */
function activityToDbData(
    activity: PolymarketActivity,
    followedUserId: string
): Prisma.ActivityEventCreateInput {
    const type = mapActivityType(activity.type);

    // Build payload with asset details
    const payload: ActivityPayload = {
        conditionId: activity.condition_id,
        marketSlug: activity.market_slug,
        assets: (activity.assets ?? []).map((asset) => ({
            assetId: asset.asset_id,
            amountMicros: sharesToMicros(asset.amount).toString(),
            outcome: asset.outcome,
        })),
        transactionHash: activity.transaction_hash,
    };

    // Add collateral amount for MERGE events
    if (activity.collateral_amount) {
        payload.collateralAmountMicros = usdcToMicros(
            activity.collateral_amount
        ).toString();
    }

    return {
        source: SOURCE,
        sourceId: activity.id,
        isCanonical: true,
        profileWallet: activity.owner,
        proxyWallet: activity.proxy_wallet ?? null,
        type,
        payloadJson: payload as object,
        eventTime: new Date(activity.timestamp),
        detectTime: new Date(),
    };
}

/**
 * Ingest activity events for a followed user from Polymarket API.
 * Returns number of new activities inserted.
 */
export async function ingestActivityForUser(
    userId: string,
    walletAddress: string,
    options?: { backfillMinutes?: number }
): Promise<number> {
    const log = logger.child({ userId, wallet: walletAddress });

    // Get last checkpoint or use backfill window
    let afterTime = await getLastActivityTime(userId);
    if (!afterTime && options?.backfillMinutes) {
        afterTime = new Date(Date.now() - options.backfillMinutes * 60 * 1000);
        log.info({ backfillMinutes: options.backfillMinutes }, "Cold start activity backfill");
    }

    // Fetch activity from API
    const activities = await fetchWalletActivity(walletAddress, {
        after: afterTime?.toISOString(),
        limit: 100,
    });

    if (activities.length === 0) {
        log.debug("No new activity events");
        return 0;
    }

    log.info({ count: activities.length }, "Fetched activity from API");

    let newCount = 0;
    let latestTime: Date | null = null;

    for (const activity of activities) {
        // Skip TRADE type - handled by trade ingestion
        if (activity.type === "TRADE") {
            continue;
        }

        const activityTime = new Date(activity.timestamp);

        // Track latest activity time for checkpoint
        if (!latestTime || activityTime > latestTime) {
            latestTime = activityTime;
        }

        // Idempotent upsert
        try {
            const dbData = activityToDbData(activity, userId);

            // Check if already exists
            const existing = await prisma.activityEvent.findFirst({
                where: {
                    source: SOURCE,
                    sourceId: activity.id,
                },
            });

            if (existing) {
                log.debug({ activityId: activity.id }, "Activity already exists, skipping");
                continue;
            }

            // Insert new activity
            const inserted = await prisma.activityEvent.create({
                data: dbData,
            });

            newCount++;
            log.debug(
                { activityId: inserted.id, type: activity.type },
                "Inserted new activity event"
            );

            // Enqueue for processing (shadow ledger, aggregation, etc.)
            await queues.ingestEvents.add("process-activity", {
                activityEventId: inserted.id,
                followedUserId: userId,
                activityType: activity.type,
            });
        } catch (err) {
            // Handle unique constraint violations gracefully
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2002"
            ) {
                log.debug({ activityId: activity.id }, "Activity already exists (constraint)");
                continue;
            }
            throw err;
        }
    }

    // Update checkpoint
    if (latestTime) {
        await setLastActivityTime(userId, latestTime);
    }

    log.info({ newCount, total: activities.length }, "Activity ingestion complete");
    return newCount;
}

/**
 * Ingest activity for all enabled followed users.
 */
export async function ingestAllUserActivity(options?: {
    backfillMinutes?: number;
}): Promise<void> {
    const users = await prisma.followedUser.findMany({
        where: { enabled: true },
    });

    logger.info({ userCount: users.length }, "Starting activity ingestion for all users");

    for (const user of users) {
        try {
            await ingestActivityForUser(user.id, user.profileWallet, options);
        } catch (err) {
            logger.error(
                { err, userId: user.id, wallet: user.profileWallet },
                "Failed to ingest activity for user"
            );
        }
    }
}
