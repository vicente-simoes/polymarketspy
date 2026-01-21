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
    id: z.string().optional().nullable(), // Polymarket market ID
    question: z.string(), // Market title/question
    slug: z.string().optional().nullable(),

    condition_id: z.string().optional().nullable(),
    conditionId: z.string().optional().nullable(),

    end_date_iso: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    endDateIso: z.string().optional().nullable(),

    // Resolution / payout fields
    umaResolutionStatus: z.string().optional().nullable(),
    outcomePrices: z.string().optional().nullable(),

    tokens: z.array(GammaTokenSchema).optional(),
    clobTokenIds: z.string().optional().nullable(),
    outcomes: z.string().optional().nullable(),
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

type QueryParamValue = string | string[];

/**
 * Per-share payout for a resolved token.
 * - Winning outcome token: 1.0 USDC per share (1_000_000 micros)
 * - Losing outcome token: 0
 */
export type TokenPayoutPerShareMicros = number;

/**
 * Make a rate-limited request to Gamma API.
 */
async function gammaRequest<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, QueryParamValue>
): Promise<T> {
    const url = new URL(path, env.GAMMA_API_BASE_URL);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            if (Array.isArray(value)) {
                for (const item of value) {
                    url.searchParams.append(key, item);
                }
                continue;
            }
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

    const parseJsonStringArray = (value: string | null | undefined): string[] | null => {
        if (!value) return null;
        try {
            const parsed = JSON.parse(value);
            if (
                Array.isArray(parsed) &&
                parsed.every((item) => typeof item === "string")
            ) {
                return parsed;
            }
        } catch {
            // ignore
        }
        return null;
    };

    const extractMetadataFromMarkets = (
        markets: GammaMarket[],
        requestedTokenIds: string[]
    ) => {
        for (const market of markets) {
            const conditionId = market.conditionId ?? market.condition_id ?? null;
            if (!conditionId) continue;

            const marketId = market.id ?? null;
            const marketSlug = market.slug ?? null;

            const closeTimeRaw =
                market.endDate ?? market.endDateIso ?? market.end_date_iso ?? null;
            const closeTime = closeTimeRaw ? new Date(closeTimeRaw) : null;

            const tokenOutcomeMap = new Map<string, string>();

            for (const token of market.tokens ?? []) {
                tokenOutcomeMap.set(token.token_id, token.outcome);
            }

            if (tokenOutcomeMap.size === 0) {
                const clobTokenIds = parseJsonStringArray(market.clobTokenIds);
                const outcomes = parseJsonStringArray(market.outcomes);

                if (clobTokenIds && outcomes && clobTokenIds.length === outcomes.length) {
                    for (let idx = 0; idx < clobTokenIds.length; idx++) {
                        const tokenId = clobTokenIds[idx];
                        const outcomeLabel = outcomes[idx];
                        if (tokenId && outcomeLabel) {
                            tokenOutcomeMap.set(tokenId, outcomeLabel);
                        }
                    }
                }
            }

            for (const tokenId of requestedTokenIds) {
                const outcomeLabel = tokenOutcomeMap.get(tokenId);
                if (!outcomeLabel) continue;

                const metadata: TokenMetadata = {
                    tokenId,
                    conditionId,
                    marketId,
                    marketSlug,
                    outcomeLabel,
                    marketTitle: market.question,
                    closeTime,
                };

                result.set(tokenId, metadata);
            }
        }
    };

    try {
        // Batch to avoid URL length limits (limit to 10 at a time).
        const batchSize = 10;
        for (let i = 0; i < tokenIds.length; i += batchSize) {
            const batch = tokenIds.slice(i, i + batchSize);

            logger.debug({ tokenCount: batch.length }, "Fetching token metadata from Gamma");

            try {
                const markets = await gammaRequest(
                    "/markets",
                    GammaMarketsResponseSchema,
                    { clob_token_ids: batch }
                );
                extractMetadataFromMarkets(markets, batch);
            } catch (err) {
                // Gamma returns 422 for any invalid token id in the batch (all-or-nothing).
                // Fall back to per-token requests to salvage valid metadata.
                logger.warn(
                    { err, tokenCount: batch.length },
                    "Gamma batch request failed; retrying tokens individually"
                );
                for (const tokenId of batch) {
                    try {
                        const markets = await gammaRequest(
                            "/markets",
                            GammaMarketsResponseSchema,
                            { clob_token_ids: [tokenId] }
                        );
                        extractMetadataFromMarkets(markets, [tokenId]);
                    } catch (tokenErr) {
                        logger.warn({ tokenErr, tokenId }, "Gamma lookup failed for token");
                    }
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
 * Fetch per-share payout (in USDC micros) for tokens that have resolved.
 *
 * Returns a Map of tokenId -> payoutPerShareMicros for tokens whose markets are
 * resolved (as indicated by Gamma's `winner` flags). Unresolved tokens are
 * omitted from the Map.
 */
export async function fetchResolvedTokenPayouts(
    tokenIds: string[]
): Promise<Map<string, TokenPayoutPerShareMicros>> {
    const uniqueTokenIds = Array.from(new Set(tokenIds)).filter((id) => /^\d+$/.test(id));
    if (uniqueTokenIds.length === 0) {
        return new Map();
    }

    const result = new Map<string, TokenPayoutPerShareMicros>();

    const requestedTokenIdsSet = new Set(uniqueTokenIds);

    const parseJsonStringArray = (value: string | null | undefined): string[] | null => {
        if (!value) return null;
        try {
            const parsed = JSON.parse(value);
            if (
                Array.isArray(parsed) &&
                parsed.every((item) => typeof item === "string")
            ) {
                return parsed;
            }
        } catch {
            // ignore
        }
        return null;
    };

    const parseJsonNumberishArray = (value: string | null | undefined): Array<number> | null => {
        if (!value) return null;
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                const numbers = parsed
                    .map((item) =>
                        typeof item === "number"
                            ? item
                            : typeof item === "string"
                              ? parseFloat(item)
                              : NaN
                    )
                    .filter((n) => Number.isFinite(n));
                if (numbers.length === parsed.length) {
                    return numbers;
                }
            }
        } catch {
            // ignore
        }
        return null;
    };

    const extractPayoutsFromMarkets = (markets: GammaMarket[]) => {
        for (const market of markets) {
            const tokens = market.tokens ?? [];

            // Path A: explicit token winner flags (preferred when present).
            if (tokens.length > 0) {
                const winningTokenIds = tokens
                    .filter((t) => t.winner === true)
                    .map((t) => t.token_id);

                // If we don't have a declared winner, the market isn't resolved (or Gamma data is incomplete).
                if (winningTokenIds.length === 0) continue;

                const winningSet = new Set(winningTokenIds);
                for (const token of tokens) {
                    if (!requestedTokenIdsSet.has(token.token_id)) continue;
                    result.set(token.token_id, winningSet.has(token.token_id) ? 1_000_000 : 0);
                }
                continue;
            }

            // Path B: fallback to outcomePrices + clobTokenIds when tokens[] are not included.
            const umaStatus = (market.umaResolutionStatus ?? "").toLowerCase();
            if (umaStatus !== "resolved") continue;

            const clobTokenIds = parseJsonStringArray(market.clobTokenIds);
            const outcomePrices = parseJsonNumberishArray(market.outcomePrices);
            if (!clobTokenIds || !outcomePrices) continue;
            if (clobTokenIds.length !== outcomePrices.length) continue;

            // Treat as resolved only if all final prices are exactly 0 or 1.
            const allBinary = outcomePrices.every((p) => p === 0 || p === 1);
            if (!allBinary) continue;

            for (let idx = 0; idx < clobTokenIds.length; idx++) {
                const tokenId = clobTokenIds[idx]!;
                if (!requestedTokenIdsSet.has(tokenId)) continue;
                result.set(tokenId, outcomePrices[idx] === 1 ? 1_000_000 : 0);
            }
        }
    };

    try {
        // Batch to avoid URL length limits (limit to 10 at a time).
        const batchSize = 10;
        for (let i = 0; i < uniqueTokenIds.length; i += batchSize) {
            const batch = uniqueTokenIds.slice(i, i + batchSize);

            logger.debug({ tokenCount: batch.length }, "Fetching token payouts from Gamma");

            try {
                const markets = await gammaRequest(
                    "/markets",
                    GammaMarketsResponseSchema,
                    { clob_token_ids: batch }
                );
                extractPayoutsFromMarkets(markets);
            } catch (err) {
                // Gamma returns 422 for any invalid token id in the batch (all-or-nothing).
                // Fall back to per-token requests to salvage valid data.
                logger.warn(
                    { err, tokenCount: batch.length },
                    "Gamma batch payout request failed; retrying tokens individually"
                );
                for (const tokenId of batch) {
                    try {
                        const markets = await gammaRequest(
                            "/markets",
                            GammaMarketsResponseSchema,
                            { clob_token_ids: [tokenId] }
                        );
                        extractPayoutsFromMarkets(markets);
                    } catch (tokenErr) {
                        logger.warn({ tokenErr, tokenId }, "Gamma payout lookup failed for token");
                    }
                }
            }

            // Small delay between batches to be nice to the API
            if (i + batchSize < uniqueTokenIds.length) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        logger.info(
            { requested: uniqueTokenIds.length, resolved: result.size },
            "Fetched resolved token payouts from Gamma"
        );

        return result;
    } catch (err) {
        logger.error({ err, tokenIds: uniqueTokenIds }, "Failed to fetch token payouts from Gamma");
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
