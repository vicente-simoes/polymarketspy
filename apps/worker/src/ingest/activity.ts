import { ActivityType, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    fetchAllWalletActivity,
    type PolymarketActivity,
    type ActivityPayload,
} from "../poly/index.js";
import {
    clearActivityIngestCursor,
    getActivityIngestCursor,
    getLastActivityTime,
    setActivityIngestCursor,
    setLastActivityTime,
} from "./checkpoint.js";
import { queues } from "../queue/queues.js";

const logger = createChildLogger({ module: "activity-ingester" });

/**
 * Source identifier for Polymarket API activity events.
 */
const SOURCE = "POLYMARKET_API";

/**
 * Map API activity type to DB enum.
 * Only MERGE, SPLIT, REDEEM are tracked as ActivityEvents.
 */
function mapActivityType(type: string): ActivityType | null {
    switch (type) {
        case "MERGE":
            return ActivityType.MERGE;
        case "SPLIT":
            return ActivityType.SPLIT;
        case "REDEEM":
            return ActivityType.REDEEM;
        default:
            // TRADE, REWARD, CONVERSION, MAKER_REBATE are not tracked here
            return null;
    }
}

/**
 * Convert a number to micros (6 decimal places).
 */
function toMicros(value: string | number | null | undefined): string {
    if (value == null) return "0";
    const numeric = typeof value === "string" ? parseFloat(value) : value;
    if (!Number.isFinite(numeric)) return "0";
    return Math.round(numeric * 1_000_000).toString();
}

/**
 * Convert API activity to database insert data.
 */
function activityToDbData(
    activity: PolymarketActivity,
    activityType: ActivityType,
    profileWallet: string
): Prisma.ActivityEventCreateInput {
    const proxyWallet =
        activity.proxyWallet && activity.proxyWallet !== profileWallet
            ? activity.proxyWallet
            : null;
    const assets = activity.asset
        ? [
              {
                  assetId: activity.asset,
                  amountMicros: toMicros(activity.size),
              },
          ]
        : [];

    // Build payload with activity details
    const payload: ActivityPayload = {
        conditionId: activity.conditionId,
        marketSlug: activity.slug,
        marketTitle: activity.title,
        outcome: activity.outcome,
        outcomeIndex: activity.outcomeIndex,
        transactionHash: activity.transactionHash,
        assets: assets.length > 0 ? assets : undefined,
        collateralAmountMicros:
            activity.usdcSize != null ? toMicros(activity.usdcSize) : undefined,
    };

    // Generate sourceId from transaction hash + timestamp + type
    // This ensures uniqueness per activity event
    const sourceId = `${activity.transactionHash ?? "unknown"}_${activity.timestamp}_${activity.type}_${activity.asset ?? "unknown"}`;

    // Convert Unix timestamp (seconds) to Date
    const eventTime = new Date(activity.timestamp * 1000);

    return {
        source: SOURCE,
        sourceId,
        isCanonical: true,
        profileWallet,
        proxyWallet,
        type: activityType,
        payloadJson: payload as object,
        eventTime,
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

    const existingCursor = await getActivityIngestCursor(userId);
    const checkpointAfterTime = await getLastActivityTime(userId);
    const checkpointAfterSeconds = checkpointAfterTime
        ? Math.floor(checkpointAfterTime.getTime() / 1000)
        : null;

    if (
        existingCursor &&
        checkpointAfterSeconds != null &&
        existingCursor.afterSeconds !== checkpointAfterSeconds
    ) {
        log.warn(
            { checkpointAfterSeconds, cursorAfterSeconds: existingCursor.afterSeconds },
            "Discarding stale activity ingest cursor (after changed)"
        );
        await clearActivityIngestCursor(userId);
    }

    const cursor = await getActivityIngestCursor(userId);

    let afterSeconds: number | undefined;
    let resumeBeforeSeconds: number | undefined;
    let sessionMaxSeenSeconds: number | undefined = cursor?.maxSeenSeconds;

    if (cursor) {
        afterSeconds = cursor.afterSeconds;
        resumeBeforeSeconds = cursor.beforeSeconds;
    } else if (checkpointAfterSeconds != null) {
        afterSeconds = checkpointAfterSeconds;
    } else {
        const backfillMinutes = options?.backfillMinutes ?? 15;
        afterSeconds = Math.floor(
            (Date.now() - backfillMinutes * 60 * 1000) / 1000
        );
        log.info(
            { backfillMinutes },
            "No activity checkpoint found; using bounded backfill window"
        );
    }

    // Fetch ALL activity from API with pagination to avoid missing events
    // during high-activity windows (e.g., >100 events in catch-up period)
    const activityFetch = await fetchAllWalletActivity(walletAddress, {
        after: afterSeconds != null ? afterSeconds.toString() : undefined,
        before: resumeBeforeSeconds != null ? resumeBeforeSeconds.toString() : undefined,
        maxPages: 10, // Safety limit: max 1000 activities per ingestion cycle
        pageSize: 100,
    });
    const activities = activityFetch.items;

    if (activities.length === 0) {
        log.debug(
            {
                exhausted: activityFetch.exhausted,
                hitMaxPages: activityFetch.hitMaxPages,
                stalled: activityFetch.stalled,
                pagesFetched: activityFetch.pagesFetched,
            },
            "No activity returned from API"
        );
    } else {
        log.info(
            {
                count: activities.length,
                exhausted: activityFetch.exhausted,
                hitMaxPages: activityFetch.hitMaxPages,
                stalled: activityFetch.stalled,
                pagesFetched: activityFetch.pagesFetched,
            },
            "Fetched activity from API (paginated)"
        );
    }

    let newCount = 0;
    let latestTime: Date | null = null;

    for (const activity of activities) {
        // Convert timestamp to Date (seconds)
        const activityTime = new Date(activity.timestamp * 1000);

        // Track latest activity time for checkpoint
        if (!latestTime || activityTime > latestTime) {
            latestTime = activityTime;
        }

        // Skip TRADE type - handled by trade ingestion
        if (activity.type === "TRADE") {
            continue;
        }

        const activityType = mapActivityType(activity.type);
        if (!activityType) {
            log.debug({ type: activity.type }, "Skipping unsupported activity type");
            continue;
        }

        // Idempotent upsert
        try {
            const dbData = activityToDbData(activity, activityType, walletAddress);

            // Check if already exists using the generated sourceId
            const existing = await prisma.activityEvent.findFirst({
                where: {
                    source: SOURCE,
                    sourceId: dbData.sourceId,
                },
            });

            if (existing) {
                log.debug({ sourceId: dbData.sourceId }, "Activity already exists, skipping");
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
                activityType,
            });
        } catch (err) {
            // Handle unique constraint violations gracefully
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2002"
            ) {
                log.debug(
                    {
                        sourceId: `${activity.transactionHash ?? "unknown"}_${activity.timestamp}_${activity.type}_${activity.asset ?? "unknown"}`,
                    },
                    "Activity already exists (constraint)"
                );
                continue;
            }
            throw err;
        }
    }

    const latestSeconds =
        latestTime != null ? Math.floor(latestTime.getTime() / 1000) : undefined;
    if (latestSeconds != null) {
        sessionMaxSeenSeconds = sessionMaxSeenSeconds == null
            ? latestSeconds
            : Math.max(sessionMaxSeenSeconds, latestSeconds);
    }

    if (activityFetch.exhausted) {
        if (sessionMaxSeenSeconds != null) {
            await setLastActivityTime(
                userId,
                new Date(sessionMaxSeenSeconds * 1000)
            );
        }
        await clearActivityIngestCursor(userId);
    } else if (activityFetch.stalled) {
        log.error(
            {
                afterSeconds,
                beforeSeconds: resumeBeforeSeconds,
                pagesFetched: activityFetch.pagesFetched,
            },
            "Activity pagination stalled; not advancing checkpoint (will retry next cycle)"
        );
        await clearActivityIngestCursor(userId);
    } else if (activityFetch.nextBefore) {
        const nextBeforeSeconds = Number(activityFetch.nextBefore);
        if (Number.isFinite(nextBeforeSeconds)) {
            await setActivityIngestCursor(userId, {
                afterSeconds: afterSeconds ?? 0,
                beforeSeconds: nextBeforeSeconds,
                maxSeenSeconds: sessionMaxSeenSeconds,
                updatedAt: new Date().toISOString(),
            });
        } else {
            log.warn(
                { nextBefore: activityFetch.nextBefore },
                "Invalid nextBefore from activity pagination; clearing cursor"
            );
            await clearActivityIngestCursor(userId);
        }
    }

    log.info({ newCount, total: activities.length }, "Activity ingestion complete");
    return newCount;
}

/**
 * Small delay between wallet fetches to spread API load.
 */
const WALLET_FETCH_DELAY_MS = 200;

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
            // Small delay between wallets to spread API load
            await new Promise((resolve) => setTimeout(resolve, WALLET_FETCH_DELAY_MS));
        } catch (err) {
            logger.error(
                { err, userId: user.id, wallet: user.profileWallet },
                "Failed to ingest activity for user"
            );
        }
    }
}
