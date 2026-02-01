const MICROS_PER_UNIT = 1_000_000n;

export type EquityPosition = {
    assetId: string;
    shareMicros: bigint;
};

export function computeEquityAndPnlMicros(args: {
    initialBankrollMicros: bigint;
    stateCashMicros: bigint;
    stateContributedCapitalMicros: bigint;
    positions: EquityPosition[];
    priceByAsset: Map<string, number>;
    defaultMarkPriceMicros: number;
}): {
    equityMicros: bigint;
    contributedCapitalMicros: bigint;
    pnlMicros: bigint;
    totalPositionValueMicros: bigint;
} {
    const cashMicros = args.initialBankrollMicros + args.stateCashMicros;
    const contributedCapitalMicros =
        args.initialBankrollMicros + args.stateContributedCapitalMicros;

    let totalPositionValueMicros = 0n;
    for (const pos of args.positions) {
        const priceMicros = args.priceByAsset.get(pos.assetId) ?? args.defaultMarkPriceMicros;
        totalPositionValueMicros += (pos.shareMicros * BigInt(priceMicros)) / MICROS_PER_UNIT;
    }

    const equityMicros = cashMicros + totalPositionValueMicros;
    const pnlMicros = equityMicros - contributedCapitalMicros;

    return {
        equityMicros,
        contributedCapitalMicros,
        pnlMicros,
        totalPositionValueMicros,
    };
}

export function getBucketMs(timestampMs: number, intervalMs: number): number {
    return Math.floor(timestampMs / intervalMs) * intervalMs;
}

export function isWithinBoundaryWindow(
    timestampMs: number,
    intervalMs: number,
    boundaryWindowMs: number
): boolean {
    const bucketMs = getBucketMs(timestampMs, intervalMs);
    return timestampMs - bucketMs <= boundaryWindowMs;
}

