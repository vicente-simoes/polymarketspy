import { createHash } from "crypto";
import { TradeSide } from "@prisma/client";

/**
 * Version prefix for idempotency keys.
 * Change this when the key basis changes to avoid collisions.
 */
const IDEMPOTENCY_KEY_VERSION = "v1";

/**
 * Generate a deterministic idempotency key for a copy intent.
 *
 * The key is derived from stable inputs that define "same intended copy trade":
 * - followedUserId
 * - tokenId
 * - side
 * - groupKey (contains window timing)
 *
 * The key is stable across retries, restarts, and worker duplicates.
 */
export function generateIdempotencyKey(
    followedUserId: string,
    tokenId: string,
    side: TradeSide,
    groupKey: string
): string {
    const basis = `${followedUserId}:${tokenId}:${side}:${groupKey}`;
    const hash = createHash("sha256").update(basis).digest("base64url").slice(0, 22);
    return `${IDEMPOTENCY_KEY_VERSION}_${hash}`;
}

