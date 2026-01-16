/**
 * Enrichment module for WS-first trades.
 *
 * Provides async enrichment of trade metadata from Gamma API.
 */

export {
    startEnrichmentProcessor,
    stopEnrichmentProcessor,
    getEnrichmentStats,
} from "./processor.js";

export {
    fetchTokenMetadata,
    fetchSingleTokenMetadata,
    type TokenMetadata,
} from "./gamma.js";
