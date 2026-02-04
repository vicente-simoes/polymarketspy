/**
 * Data API Client for Position Fetching
 *
 * Provides a fallback method to fetch positions from Polymarket Data API
 * since the CLOB client doesn't support position queries directly.
 *
 * Used by state reconciliation to get authoritative position data.
 */

import { request } from "undici";
import { z } from "zod";
import { env } from "../../config/env.js";
import { polymarketHighPriorityLimiter } from "../../http/limiters.js";
import { createChildLogger } from "../../log/logger.js";
import type { AuthoritativePosition } from "./types.js";

const logger = createChildLogger({ module: "data-api-client" });

// ─── Response Schema ──────────────────────────────────────────────────────────

/**
 * Position response from Data API /positions endpoint.
 */
const DataApiPositionSchema = z.object({
    asset: z.string(), // tokenId
    position: z.string(), // decimal string
    avg_price: z.string().optional(),
    // Additional fields exist but we only need these
});

const DataApiPositionsResponseSchema = z.array(DataApiPositionSchema);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch positions for a wallet from the Data API.
 *
 * This is the fallback method used when CLOB client getPositions() returns null.
 * Returns null on error to allow graceful degradation.
 *
 * @param walletAddress - The wallet address to fetch positions for
 * @returns Array of positions or null on failure
 */
export async function fetchPositionsFromDataApi(
    walletAddress: string
): Promise<AuthoritativePosition[] | null> {
    const log = logger.child({ wallet: walletAddress });

    try {
        const url = new URL("/positions", env.POLYMARKET_DATA_API_BASE_URL);
        url.searchParams.set("user", walletAddress);

        const response = await polymarketHighPriorityLimiter.schedule(async () => {
            log.debug({ url: url.toString() }, "Fetching positions from Data API");

            const res = await request(url.toString(), {
                method: "GET",
                headers: { Accept: "application/json" },
            });

            if (res.statusCode !== 200) {
                const body = await res.body.text();
                throw new Error(`Data API error ${res.statusCode}: ${body}`);
            }

            return res.body.json();
        });

        const parsed = DataApiPositionsResponseSchema.parse(response);

        // Convert to AuthoritativePosition format
        const positions: AuthoritativePosition[] = parsed
            .map((p) => ({
                tokenId: p.asset,
                shareMicros: decimalToShareMicros(p.position),
            }))
            .filter((p) => p.shareMicros !== 0n); // Filter out zero positions

        log.debug({ positionCount: positions.length }, "Fetched positions from Data API");
        return positions;
    } catch (err) {
        log.error({ err }, "Failed to fetch positions from Data API");
        return null;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert decimal position string to share micros.
 */
function decimalToShareMicros(decimal: string): bigint {
    const value = parseFloat(decimal);
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.round(value * 1_000_000));
}
