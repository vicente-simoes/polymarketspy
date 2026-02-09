import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { getOrSetServerCache } from "@/lib/server-cache"
import { withPgStatementTimeout } from "@/lib/pg-guardrails"
import { PortfolioScope, TradingMode } from "@prisma/client"

const MICROS_PER_UNIT = BigInt(1_000_000)
const DEFAULT_MARK_PRICE_MICROS = 500_000 // $0.50

const LIVE_BASELINE_TIME_KEY = "live:baselineTime"
const LIVE_BASELINE_EQUITY_KEY = "live:baselineEquityMicros"
const LIVE_LEDGER_DIFF_KEY = "live:ledgerVsExchangeDiff"

function absBigint(value: bigint): bigint {
    return value < BigInt(0) ? -value : value
}

function parseTimestamp(valueJson: unknown): string | null {
    const raw = (valueJson as any)?.timestamp
    return typeof raw === "string" && raw.length > 0 ? raw : null
}

function parseBigintField(valueJson: unknown, field: string): bigint | null {
    const raw = (valueJson as any)?.[field]
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return BigInt(Math.trunc(raw))
    }
    if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
        try {
            return BigInt(raw)
        } catch {
            return null
        }
    }
    return null
}

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const payload = await getOrSetServerCache("portfolio:live:global", 10_000, async () => {
            return withPgStatementTimeout(4000, async (tx) => {
                const [
                    baselineTimeRow,
                    baselineEquityRow,
                    ledgerDiffRow,
                    globalState,
                    currentPositions,
                ] = await Promise.all([
                    tx.systemCheckpoint.findUnique({
                        where: { key: LIVE_BASELINE_TIME_KEY },
                        select: { valueJson: true },
                    }),
                    tx.systemCheckpoint.findUnique({
                        where: { key: LIVE_BASELINE_EQUITY_KEY },
                        select: { valueJson: true },
                    }),
                    tx.systemCheckpoint.findUnique({
                        where: { key: LIVE_LEDGER_DIFF_KEY },
                        select: { valueJson: true },
                    }),
                    tx.globalPortfolioState.findUnique({
                        where: {
                            tradingMode_portfolioScope: {
                                tradingMode: TradingMode.LIVE,
                                portfolioScope: PortfolioScope.EXEC_GLOBAL,
                            },
                        },
                        select: { cashMicros: true, updatedAt: true },
                    }),
                    tx.currentPosition.findMany({
                        where: { tradingMode: TradingMode.LIVE, shareMicros: { not: BigInt(0) } },
                        select: { assetId: true, marketId: true, shareMicros: true },
                    }),
                ])

                const baselineTime = baselineTimeRow ? parseTimestamp(baselineTimeRow.valueJson) : null
                const baselineEquityMicrosRaw = baselineEquityRow
                    ? parseBigintField(baselineEquityRow.valueJson, "equityMicros")
                    : null

                const cashMicros = globalState?.cashMicros ?? BigInt(0)
                const positionAssetIds = currentPositions.map((pos) => pos.assetId)

                const [priceRows, tokenMetadata] = await Promise.all([
                    positionAssetIds.length
                        ? tx.currentPrice.findMany({
                              where: { assetId: { in: positionAssetIds } },
                              select: { assetId: true, midpointPriceMicros: true },
                          })
                        : Promise.resolve([]),
                    positionAssetIds.length
                        ? tx.tokenMetadataCache.findMany({
                              where: { tokenId: { in: positionAssetIds } },
                              select: {
                                  tokenId: true,
                                  marketId: true,
                                  marketTitle: true,
                                  outcomeLabel: true,
                              },
                          })
                        : Promise.resolve([]),
                ])

                const tokenMetadataMap = new Map(tokenMetadata.map((meta) => [meta.tokenId, meta]))
                const priceByAsset = new Map(priceRows.map((row) => [row.assetId, row.midpointPriceMicros]))

                let totalPositionValueMicros = BigInt(0)
                let exposureMicros = BigInt(0)

                const enrichedPositions = currentPositions.map((pos) => {
                    const meta = tokenMetadataMap.get(pos.assetId) ?? null
                    const markMicros = priceByAsset.get(pos.assetId) ?? null
                    const markPrice = markMicros !== null ? markMicros / 1_000_000 : null

                    const markForEquityMicros = markMicros ?? DEFAULT_MARK_PRICE_MICROS
                    const valueForEquityMicros =
                        (pos.shareMicros * BigInt(markForEquityMicros)) / MICROS_PER_UNIT
                    totalPositionValueMicros += valueForEquityMicros
                    exposureMicros += absBigint(valueForEquityMicros)

                    const marketValueMicros =
                        markMicros !== null
                            ? (pos.shareMicros * BigInt(markMicros)) / MICROS_PER_UNIT
                            : null
                    const marketValue =
                        marketValueMicros !== null ? Number(marketValueMicros) / 1_000_000 : null

                    return {
                        assetId: pos.assetId,
                        marketId: pos.marketId ?? meta?.marketId ?? null,
                        shares: Number(pos.shareMicros) / 1_000_000,
                        markPrice,
                        marketValue,
                        marketTitle: meta?.marketTitle || "Unknown Market",
                        outcome: meta?.outcomeLabel || "Unknown",
                    }
                })

                const equityMicros = cashMicros + totalPositionValueMicros
                const baselineEquityMicros = baselineEquityMicrosRaw ?? equityMicros
                const pnlMicros = equityMicros - baselineEquityMicros

                const equity = Number(equityMicros) / 1_000_000
                const cash = Number(cashMicros) / 1_000_000
                const exposure = Number(exposureMicros) / 1_000_000
                const pnlSinceBaseline = Number(pnlMicros) / 1_000_000

                const ledgerVsExchangeDiff = ledgerDiffRow?.valueJson
                    ? {
                          asOf:
                              typeof (ledgerDiffRow.valueJson as any)?.asOf === "string"
                                  ? (ledgerDiffRow.valueJson as any).asOf
                                  : null,
                          cashDiffMicros:
                              typeof (ledgerDiffRow.valueJson as any)?.cashDiffMicros === "string"
                                  ? (ledgerDiffRow.valueJson as any).cashDiffMicros
                                  : "0",
                          positionDiffCount:
                              typeof (ledgerDiffRow.valueJson as any)?.positionDiffCount === "number"
                                  ? (ledgerDiffRow.valueJson as any).positionDiffCount
                                  : 0,
                          maxAbsPositionDiffMicros:
                              typeof (ledgerDiffRow.valueJson as any)?.maxAbsPositionDiffMicros === "string"
                                  ? (ledgerDiffRow.valueJson as any).maxAbsPositionDiffMicros
                                  : "0",
                      }
                    : null

                return {
                    baseline: {
                        time: baselineTime,
                        equity: Number(baselineEquityMicros) / 1_000_000,
                    },
                    lastReconciledAt: globalState?.updatedAt ? globalState.updatedAt.toISOString() : null,
                    ledgerVsExchangeDiff,
                    positions: enrichedPositions,
                    metrics: {
                        equity,
                        cash,
                        exposure,
                        pnlSinceBaseline,
                    },
                }
            })
        })

        return NextResponse.json(payload)
    } catch (error) {
        console.error("Failed to fetch live global portfolio:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

