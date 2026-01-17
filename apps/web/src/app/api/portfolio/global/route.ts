import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const guardrails = await prisma.guardrailConfig.findFirst({
            where: { scope: "GLOBAL" }
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

        const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
            where: { portfolioScope: "EXEC_GLOBAL", followedUserId: null },
            orderBy: { bucketTime: "desc" }
        })

        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        const equityCurveSnapshots = await prisma.portfolioSnapshot.findMany({
            where: {
                portfolioScope: "EXEC_GLOBAL",
                followedUserId: null,
                bucketTime: { gte: thirtyDaysAgo }
            },
            orderBy: { bucketTime: "asc" }
        })

        const equityCurve = equityCurveSnapshots.map((snapshot) => ({
            ts: snapshot.bucketTime.getTime(),
            value: Number(snapshot.equityMicros) / 1_000_000
        }))

        let peakEquity = 0
        let maxDrawdown = 0
        let currentDrawdown = 0
        for (const point of equityCurve) {
            if (point.value > peakEquity) {
                peakEquity = point.value
            }
            if (peakEquity > 0) {
                const drawdown = (peakEquity - point.value) / peakEquity
                if (drawdown > maxDrawdown) {
                    maxDrawdown = drawdown
                }
                currentDrawdown = drawdown
            }
        }

        const positionsRaw = await prisma.ledgerEntry.groupBy({
            by: ["assetId", "marketId"],
            where: { portfolioScope: "EXEC_GLOBAL" },
            _sum: {
                shareDeltaMicros: true,
                cashDeltaMicros: true
            },
            having: {
                shareDeltaMicros: {
                    _sum: { not: { equals: 0 } }
                }
            }
        })

        const assetIds = positionsRaw
            .map((p: any) => p.assetId)
            .filter((id: any) => id !== null) as string[]
        const tokenMetadata = assetIds.length
            ? await prisma.tokenMetadataCache.findMany({
                  where: { tokenId: { in: assetIds } },
                  select: {
                      tokenId: true,
                      marketTitle: true,
                      outcomeLabel: true
                  }
              })
            : []
        const tokenMetadataMap = new Map(
            tokenMetadata.map((meta) => [meta.tokenId, meta])
        )
        const priceSnapshots = assetIds.length
            ? await prisma.marketPriceSnapshot.findMany({
                  where: { assetId: { in: assetIds } },
                  orderBy: { bucketTime: "desc" },
                  distinct: ["assetId"]
              })
            : []

        const priceMap = new Map(
            priceSnapshots.map((snap) => [snap.assetId, snap.midpointPriceMicros])
        )

        const enrichedPositions = positionsRaw.map((p: any) => {
            const meta = p.assetId ? tokenMetadataMap.get(p.assetId) : null
            const shares = Number(p._sum.shareDeltaMicros) / 1_000_000
            const netCashFlow = Number(p._sum.cashDeltaMicros) / 1_000_000
            const priceMicros = p.assetId ? priceMap.get(p.assetId) : null
            const markPrice = priceMicros ? priceMicros / 1_000_000 : null
            const marketValue =
                markPrice !== null ? markPrice * shares : null

            return {
                assetId: p.assetId,
                marketId: p.marketId,
                shares,
                invested: -netCashFlow,
                markPrice,
                marketValue,
                marketTitle: meta?.marketTitle || "Unknown Market",
                outcome: meta?.outcomeLabel || "Unknown"
            }
        })

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

            const marketId = position.marketId ?? "unknown"
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

        const userSnapshots = await prisma.portfolioSnapshot.findMany({
            where: {
                portfolioScope: "EXEC_GLOBAL",
                followedUserId: { not: null }
            },
            orderBy: { bucketTime: "desc" },
            distinct: ["followedUserId"]
        })

        const userIds = userSnapshots
            .map((snap) => snap.followedUserId)
            .filter((id): id is string => Boolean(id))
        const users = userIds.length
            ? await prisma.followedUser.findMany({
                  where: { id: { in: userIds } },
                  select: { id: true, label: true }
              })
            : []
        const userLabelMap = new Map(users.map((u) => [u.id, u.label]))

        const exposureByUserRaw = userSnapshots
            .map((snap) => ({
                userId: snap.followedUserId as string,
                label: userLabelMap.get(snap.followedUserId as string) || "Unknown",
                exposure: Number(snap.exposureMicros) / 1_000_000
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

        const equity = latestSnapshot
            ? Number(latestSnapshot.equityMicros) / 1_000_000
            : 0
        const cash = latestSnapshot
            ? Number(latestSnapshot.cashMicros) / 1_000_000
            : 0
        const exposure = latestSnapshot
            ? Number(latestSnapshot.exposureMicros) / 1_000_000
            : 0
        const pnl = latestSnapshot
            ? Number(
                  latestSnapshot.realizedPnlMicros + latestSnapshot.unrealizedPnlMicros
              ) / 1_000_000
            : 0

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

        return NextResponse.json({
            positions: enrichedPositions,
            exposureByMarket,
            exposureByUser,
            equityCurve,
            metrics: {
                equity,
                cash,
                exposure,
                pnl,
                exposurePct,
                maxTotalExposurePct,
                riskUtilizationPct,
                maxDrawdownPct,
                currentDrawdownPct,
                maxDrawdownLimitPct,
                drawdownUtilizationPct
            }
        })
    } catch (error) {
        console.error("Failed to fetch global portfolio:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
