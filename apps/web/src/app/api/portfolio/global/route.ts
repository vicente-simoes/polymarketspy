import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { getOrSetServerCache } from "@/lib/server-cache"
import { withPgStatementTimeout } from "@/lib/pg-guardrails"

const MICROS_PER_UNIT = BigInt(1_000_000)
const DEFAULT_MARK_PRICE_MICROS = 500_000 // $0.50

function absBigint(value: bigint): bigint {
    return value < BigInt(0) ? -value : value
}

function parseInitialBankrollMicros(valueJson: unknown): bigint {
    const raw = (valueJson as any)?.initialBankrollMicros
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return BigInt(Math.trunc(raw))
    }
    if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
        try {
            return BigInt(raw)
        } catch {
            return BigInt(0)
        }
    }
    return BigInt(0)
}

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const payload = await getOrSetServerCache("portfolio:global", 10_000, async () => {
            return withPgStatementTimeout(4000, async (tx) => {
                const guardrails = await tx.guardrailConfig.findFirst({
                    where: { scope: "GLOBAL", followedUserId: null },
                    orderBy: { updatedAt: "desc" }
                })
                const guardrailsConfig = (guardrails?.configJson || {}) as Record<string, any>
                const maxTotalExposureBps =
                    typeof guardrailsConfig.maxTotalExposureBps === "number"
                        ? guardrailsConfig.maxTotalExposureBps
                        : 7000
                const maxDrawdownLimitBps =
                    typeof guardrailsConfig.maxDrawdownLimitBps === "number"
                        ? guardrailsConfig.maxDrawdownLimitBps
                        : 1200

                const thirtyDaysAgo = new Date()
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
                const [
                    systemConfigRow,
                    globalState,
                    currentPositions,
                    leaderPositions,
                    drawdownPoints
                ] = await Promise.all([
                    tx.systemCheckpoint.findUnique({
                        where: { key: "system:config" },
                        select: { valueJson: true }
                    }),
                    tx.globalPortfolioState.findUnique({
                        where: { id: "EXEC_GLOBAL" },
                        select: { cashMicros: true, contributedCapitalMicros: true }
                    }),
                    tx.currentPosition.findMany({
                        where: { shareMicros: { not: BigInt(0) } },
                        select: {
                            assetId: true,
                            marketId: true,
                            shareMicros: true,
                            netCashFlowMicros: true
                        }
                    }),
                    tx.currentPositionByLeader.findMany({
                        where: { shareMicros: { not: BigInt(0) } },
                        select: { followedUserId: true, assetId: true, shareMicros: true }
                    }),
                    tx.equityPoint.findMany({
                        where: {
                            granularity: "H12",
                            bucketTime: { gte: thirtyDaysAgo }
                        },
                        orderBy: { bucketTime: "asc" }
                    })
                ])

        const initialBankrollMicros = parseInitialBankrollMicros(systemConfigRow?.valueJson)
        const cashMicros = initialBankrollMicros + (globalState?.cashMicros ?? BigInt(0))
        const contributedCapitalMicros =
            initialBankrollMicros + (globalState?.contributedCapitalMicros ?? BigInt(0))

        let peakEquity = 0
        let maxDrawdown = 0
        let currentDrawdown = 0
        for (const point of drawdownPoints) {
            const equity = Number(point.equityMicros) / 1_000_000
            if (equity > peakEquity) {
                peakEquity = equity
            }
            if (peakEquity > 0) {
                const drawdown = (peakEquity - equity) / peakEquity
                if (drawdown > maxDrawdown) {
                    maxDrawdown = drawdown
                }
                currentDrawdown = drawdown
            }
        }

        const positionAssetIds = currentPositions.map((pos) => pos.assetId)
        const leaderAssetIds = Array.from(new Set(leaderPositions.map((row) => row.assetId)))
        const allAssetIds = Array.from(new Set([...positionAssetIds, ...leaderAssetIds]))

        const [priceRows, tokenMetadata] = await Promise.all([
            allAssetIds.length
                ? tx.currentPrice.findMany({
                      where: { assetId: { in: allAssetIds } },
                      select: { assetId: true, midpointPriceMicros: true }
                  })
                : Promise.resolve([]),
            positionAssetIds.length
                ? tx.tokenMetadataCache.findMany({
                      where: { tokenId: { in: positionAssetIds } },
                      select: {
                          tokenId: true,
                          marketId: true,
                          marketTitle: true,
                          outcomeLabel: true
                      }
                  })
                : Promise.resolve([])
        ])

        const tokenMetadataMap = new Map(tokenMetadata.map((meta) => [meta.tokenId, meta]))
        const priceByAsset = new Map(priceRows.map((row) => [row.assetId, row.midpointPriceMicros]))

        let totalPositionValueMicros = BigInt(0)
        let exposureMicros = BigInt(0)

        const enrichedPositions = currentPositions.map((pos) => {
            const meta = tokenMetadataMap.get(pos.assetId) ?? null
            const markMicros = priceByAsset.get(pos.assetId) ?? null
            const markPrice = markMicros !== null ? markMicros / 1_000_000 : null
            const marketValueMicros =
                markMicros !== null
                    ? (pos.shareMicros * BigInt(markMicros)) / MICROS_PER_UNIT
                    : null
            const marketValue =
                marketValueMicros !== null ? Number(marketValueMicros) / 1_000_000 : null

            const markForEquityMicros = markMicros ?? DEFAULT_MARK_PRICE_MICROS
            const valueForEquityMicros =
                (pos.shareMicros * BigInt(markForEquityMicros)) / MICROS_PER_UNIT
            totalPositionValueMicros += valueForEquityMicros
            exposureMicros += absBigint(valueForEquityMicros)

            const shares = Number(pos.shareMicros) / 1_000_000
            const invested = -Number(pos.netCashFlowMicros) / 1_000_000

            return {
                assetId: pos.assetId,
                marketId: pos.marketId ?? meta?.marketId ?? null,
                shares,
                invested,
                markPrice,
                marketValue,
                marketTitle: meta?.marketTitle || "Unknown Market",
                outcome: meta?.outcomeLabel || "Unknown"
            }
        })

        const equityMicros = cashMicros + totalPositionValueMicros
        const pnlMicros = equityMicros - contributedCapitalMicros
        const equity = Number(equityMicros) / 1_000_000
        const cash = Number(cashMicros) / 1_000_000
        const exposure = Number(exposureMicros) / 1_000_000
        const pnl = Number(pnlMicros) / 1_000_000

        const exposureByMarketMap = new Map<
            string,
            { marketId: string; marketTitle: string; exposure: number }
        >()
        let totalExposureValue = 0

        for (const position of enrichedPositions) {
            const exposureValue = Math.abs(
                position.marketValue ?? position.invested
            )
            totalExposureValue += exposureValue

            const marketId = position.marketId ?? position.assetId ?? "unknown"
            const current = exposureByMarketMap.get(marketId)
            if (current) {
                current.exposure += exposureValue
            } else {
                exposureByMarketMap.set(marketId, {
                    marketId,
                    marketTitle: position.marketTitle,
                    exposure: exposureValue
                })
            }
        }

        const exposureByMarketSorted = Array.from(exposureByMarketMap.values())
            .sort((a, b) => b.exposure - a.exposure)
            .map((item) => ({
                ...item,
                pct:
                    totalExposureValue > 0
                        ? (item.exposure / totalExposureValue) * 100
                        : 0
            }))

        const exposureByMarketTop = exposureByMarketSorted.slice(0, 10)
        const exposureByMarketOverflow = exposureByMarketSorted
            .slice(10)
            .reduce((sum, item) => sum + item.exposure, 0)

        const exposureByMarket =
            exposureByMarketOverflow > 0
                ? [
                      ...exposureByMarketTop,
                      {
                          marketId: "other",
                          marketTitle: "Other",
                          exposure: exposureByMarketOverflow,
                          pct:
                              totalExposureValue > 0
                                  ? (exposureByMarketOverflow / totalExposureValue) * 100
                                  : 0
                      }
                  ]
                : exposureByMarketTop

        // Per-user snapshots are no longer written. Compute current exposure-by-leader from caches.
        const exposureMicrosByUser = new Map<string, bigint>()
        for (const row of leaderPositions) {
            const priceMicros =
                priceByAsset.get(row.assetId) ?? DEFAULT_MARK_PRICE_MICROS
            const positionValueMicros =
                (row.shareMicros * BigInt(priceMicros)) / MICROS_PER_UNIT
            const absValue = absBigint(positionValueMicros)

            const current = exposureMicrosByUser.get(row.followedUserId) ?? BigInt(0)
            exposureMicrosByUser.set(row.followedUserId, current + absValue)
        }

        const userIds = Array.from(exposureMicrosByUser.keys())
        const users = userIds.length
            ? await tx.followedUser.findMany({
                  where: { id: { in: userIds } },
                  select: { id: true, label: true }
              })
            : []
        const userLabelMap = new Map(users.map((u) => [u.id, u.label]))

        const exposureByUserRaw = Array.from(exposureMicrosByUser.entries())
            .map(([userId, exposureMicros]) => ({
                userId,
                label: userLabelMap.get(userId) || "Unknown",
                exposure: Number(exposureMicros) / 1_000_000
            }))
            .filter((item) => item.exposure > 0)
            .sort((a, b) => b.exposure - a.exposure)

        const totalUserExposure = exposureByUserRaw.reduce(
            (sum, item) => sum + item.exposure,
            0
        )

        const exposureByUserSorted = exposureByUserRaw.map((item) => ({
            ...item,
            pct: totalUserExposure > 0 ? (item.exposure / totalUserExposure) * 100 : 0
        }))

        const exposureByUserTop = exposureByUserSorted.slice(0, 10)
        const exposureByUserOverflow = exposureByUserSorted
            .slice(10)
            .reduce((sum, item) => sum + item.exposure, 0)

        const exposureByUser =
            exposureByUserOverflow > 0
                ? [
                      ...exposureByUserTop,
                      {
                          userId: "other",
                          label: "Other",
                          exposure: exposureByUserOverflow,
                          pct:
                              totalUserExposure > 0
                                  ? (exposureByUserOverflow / totalUserExposure) * 100
                                  : 0
                      }
                  ]
                : exposureByUserTop

        const nowMs = Date.now()
        const [pnl1hPoint, pnl24hPoint, pnl7dPoint, pnl30dPoint] = await Promise.all([
            tx.equityPoint.findFirst({
                where: {
                    granularity: "M1",
                    bucketTime: { lte: new Date(nowMs - 60 * 60 * 1000) }
                },
                orderBy: { bucketTime: "desc" }
            }),
            tx.equityPoint.findFirst({
                where: {
                    granularity: "M20",
                    bucketTime: { lte: new Date(nowMs - 24 * 60 * 60 * 1000) }
                },
                orderBy: { bucketTime: "desc" }
            }),
            tx.equityPoint.findFirst({
                where: {
                    granularity: "H2",
                    bucketTime: { lte: new Date(nowMs - 7 * 24 * 60 * 60 * 1000) }
                },
                orderBy: { bucketTime: "desc" }
            }),
            tx.equityPoint.findFirst({
                where: {
                    granularity: "H12",
                    bucketTime: { lte: new Date(nowMs - 30 * 24 * 60 * 60 * 1000) }
                },
                orderBy: { bucketTime: "desc" }
            })
        ])

        const pnl1h = pnl1hPoint ? pnl - Number(pnl1hPoint.pnlMicros) / 1_000_000 : null
        const pnl24h = pnl24hPoint ? pnl - Number(pnl24hPoint.pnlMicros) / 1_000_000 : null
        const pnl7d = pnl7dPoint ? pnl - Number(pnl7dPoint.pnlMicros) / 1_000_000 : null
        const pnl30d = pnl30dPoint ? pnl - Number(pnl30dPoint.pnlMicros) / 1_000_000 : null

        const exposurePct = equity > 0 ? (exposure / equity) * 100 : 0
        const maxTotalExposurePct = maxTotalExposureBps / 100
        const riskUtilizationPct =
            maxTotalExposurePct > 0
                ? (exposurePct / maxTotalExposurePct) * 100
                : 0
        const maxDrawdownPct = maxDrawdown * 100
        const currentDrawdownPct = currentDrawdown * 100
        const maxDrawdownLimitPct = maxDrawdownLimitBps / 100
        const drawdownUtilizationPct =
            maxDrawdownLimitPct > 0
                ? (maxDrawdownPct / maxDrawdownLimitPct) * 100
                : 0

        return {
            positions: enrichedPositions,
            exposureByMarket,
            exposureByUser,
            metrics: {
                equity,
                cash,
                exposure,
                pnl,
                pnl1h,
                pnl24h,
                pnl7d,
                pnl30d,
                exposurePct,
                maxTotalExposurePct,
                riskUtilizationPct,
                maxDrawdownPct,
                currentDrawdownPct,
                maxDrawdownLimitPct,
                drawdownUtilizationPct
            }
        }
            })
        })

        return NextResponse.json(payload)
    } catch (error) {
        console.error("Failed to fetch global portfolio:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
