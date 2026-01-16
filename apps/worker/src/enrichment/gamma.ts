/**
 * Gamma API client for market metadata enrichment.
 *
 * Gamma is Polymarket's market metadata API. We use it to fetch:
 * - Market title and description
 * - Outcome labels (Yes/No or custom)
 * - Market close time
 * - Condition ID mapping
 *
 * API base: https://gamma-api.polymarket.com
 */

import { request } from "undici";
import { z } from "zod";
import { env } from "../config/env.js";
import { gammaLimiter } from "../http/limiters.js";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "gamma-api" });

/**
 * Gamma market token schema.
 */
const GammaTokenSchema = z.object({
    token_id: z.string(),
    outcome: z.string(), // "Yes", "No", or custom outcome
    winner: z.boolean().optional(),
});

/**
 * Gamma market schema (simplified - only fields we need).
 */
const GammaMarketSchema = z.object({
    id: z.string().optional(), // Polymarket market ID (may not always be present)
    condition_id: z.string(),
    question: z.string(), // Market title/question
    slug: z.string().optional(),
    end_date_iso: z.string().optional(), // Close time as ISO string
    tokens: z.array(GammaTokenSchema).optional(),
    // There are many more fields but we only need these
});

/**
 * Response from /markets endpoint.
 */
const GammaMarketsResponseSchema = z.array(GammaMarketSchema);

export type GammaMarket = z.infer<typeof GammaMarketSchema>;
export type GammaToken = z.infer<typeof GammaTokenSchema>;

/**
 * Token metadata extracted from Gamma response.
 */
export interface TokenMetadata {
    tokenId: string;
    conditionId: string;
    marketId: string | null;
    marketSlug: string | null;
    outcomeLabel: string;
    marketTitle: string;
    closeTime: Date | null;
}

/**
 * Make a rate-limited request to Gamma API.
 */
async function gammaRequest<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
): Promise<T> {
    const url = new URL(path, env.GAMMA_API_BASE_URL);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
    }

    return gammaLimiter.schedule(async () => {
        logger.debug({ url: url.toString() }, "Gamma API request");
        const response = await request(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
        });

        if (response.statusCode !== 200) {
            const body = await response.body.text();
            throw new Error(`Gamma API error ${response.statusCode}: ${body}`);
        }

        const json = await response.body.json();
        return schema.parse(json);
    });
}

/**
 * Fetch market metadata by CLOB token IDs.
 *
 * The Gamma API supports querying by clob_token_ids parameter.
 * Returns markets that contain any of the specified token IDs.
 *
 * @param tokenIds - Array of CLOB token IDs to look up
 * @returns Map of tokenId -> TokenMetadata
 */
export async function fetchTokenMetadata(
    tokenIds: string[]
): Promise<Map<string, TokenMetadata>> {
    if (tokenIds.length === 0) {
        return new Map();
    }

    const result = new Map<string, TokenMetadata>();

    try {
        // Gamma API accepts comma-separated token IDs
        // Batch to avoid URL length limits (limit to 10 at a time)
        const batchSize = 10;
        for (let i = 0; i < tokenIds.length; i += batchSize) {
            const batch = tokenIds.slice(i, i + batchSize);
            const tokenIdsParam = batch.join(",");

            logger.debug({ tokenCount: batch.length }, "Fetching token metadata from Gamma");

            const markets = await gammaRequest(
                "/markets",
                GammaMarketsResponseSchema,
                { clob_token_ids: tokenIdsParam }
            );

            // Extract metadata for each token
            for (const market of markets) {
                const tokens = market.tokens ?? [];

                for (const token of tokens) {
                    // Only process tokens we requested
                    if (!batch.includes(token.token_id)) {
                        continue;
                    }

                    const metadata: TokenMetadata = {
                        tokenId: token.token_id,
                        conditionId: market.condition_id,
                        marketId: market.id ?? null,
                        marketSlug: market.slug ?? null,
                        outcomeLabel: token.outcome,
                        marketTitle: market.question,
                        closeTime: market.end_date_iso
                            ? new Date(market.end_date_iso)
                            : null,
                    };

                    result.set(token.token_id, metadata);

                    logger.debug(
                        {
                            tokenId: token.token_id,
                            outcome: token.outcome,
                            market: market.question.slice(0, 50),
                        },
                        "Resolved token metadata"
                    );
                }
            }

            // Small delay between batches to be nice to the API
            if (i + batchSize < tokenIds.length) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        logger.info(
            { requested: tokenIds.length, resolved: result.size },
            "Fetched token metadata from Gamma"
        );

        return result;
    } catch (err) {
        logger.error({ err, tokenIds }, "Failed to fetch token metadata from Gamma");
        throw err;
    }
}

/**
 * Fetch metadata for a single token.
 * Convenience wrapper around fetchTokenMetadata.
 */
export async function fetchSingleTokenMetadata(
    tokenId: string
): Promise<TokenMetadata | null> {
    const result = await fetchTokenMetadata([tokenId]);
    return result.get(tokenId) ?? null;
}
