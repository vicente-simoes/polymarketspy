import { EquityPointGranularity } from "@prisma/client";

export const EQUITY_TICK_INTERVAL_MS = 60_000;

// We only write coarse points (20m/2h/12h/1d) shortly after a bucket boundary.
// This avoids accidentally overwriting historical points mid-bucket after restarts.
export const EQUITY_BOUNDARY_WINDOW_MS = 5 * 60_000;

export const EQUITY_GRANULARITIES: Array<{
    granularity: EquityPointGranularity;
    intervalMs: number;
    retentionMs: number | null;
}> = [
    {
        granularity: EquityPointGranularity.M1,
        intervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
    },
    {
        granularity: EquityPointGranularity.M20,
        intervalMs: 20 * 60_000,
        retentionMs: 90 * 24 * 60 * 60 * 1000,
    },
    {
        granularity: EquityPointGranularity.H2,
        intervalMs: 2 * 60 * 60_000,
        retentionMs: 18 * 30 * 24 * 60 * 60 * 1000,
    },
    {
        granularity: EquityPointGranularity.H12,
        intervalMs: 12 * 60 * 60_000,
        retentionMs: 5 * 365 * 24 * 60 * 60 * 1000,
    },
    {
        granularity: EquityPointGranularity.D1,
        intervalMs: 24 * 60 * 60_000,
        retentionMs: null, // keep forever
    },
];

