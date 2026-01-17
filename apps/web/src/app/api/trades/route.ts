import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function GET(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get("limit") || "50")
    const marketId = searchParams.get("marketId")
    const userId = searchParams.get("userId")

    const cursor = searchParams.get("cursor")

    try {
        const where = {
            ...(marketId && { marketId }),
            ...(userId && {
                OR: [
                    { profileWallet: userId },
                ]
            })
        }

        const [total, trades] = await Promise.all([
            prisma.tradeEvent.count({ where }),
            prisma.tradeEvent.findMany({
                where,
                take: limit,
                skip: cursor ? 1 : 0,
                cursor: cursor ? { id: cursor } : undefined,
                orderBy: [
                    { eventTime: 'desc' },
                    { id: 'desc' }
                ]
            })
        ])

        const tokenIds = Array.from(
            new Set(
                trades
                    .map((trade) => trade.rawTokenId ?? trade.assetId)
                    .filter((tokenId): tokenId is string => Boolean(tokenId))
            )
        )

        const tokenMetadata = tokenIds.length
            ? await prisma.tokenMetadataCache.findMany({
                  where: { tokenId: { in: tokenIds } },
                  select: {
                      tokenId: true,
                      marketTitle: true,
                      marketSlug: true,
                      outcomeLabel: true
                  }
              })
            : []

        const tokenMetadataMap = new Map(
            tokenMetadata.map((meta) => [meta.tokenId, meta])
        )

        const profileWallets = Array.from(
            new Set(trades.map((trade) => trade.profileWallet))
        )
        const followedUsers = await prisma.followedUser.findMany({
            where: { profileWallet: { in: profileWallets } },
            select: { profileWallet: true, label: true }
        })
        const labelMap = new Map(
            followedUsers.map((user) => [user.profileWallet, user.label])
        )

        // Convert BigInt fields to strings for JSON serialization
        const serializedTrades = trades.map((trade) => ({
            marketTitle:
                tokenMetadataMap.get(trade.rawTokenId ?? trade.assetId ?? "")?.marketTitle ??
                null,
            marketSlug:
                tokenMetadataMap.get(trade.rawTokenId ?? trade.assetId ?? "")?.marketSlug ??
                null,
            outcomeLabel:
                tokenMetadataMap.get(trade.rawTokenId ?? trade.assetId ?? "")?.outcomeLabel ??
                null,
            ...trade,
            shareMicros: trade.shareMicros.toString(),
            notionalMicros: trade.notionalMicros.toString(),
            feeMicros: trade.feeMicros?.toString() ?? "0",
            userLabel: labelMap.get(trade.profileWallet) ?? null
        }))

        return NextResponse.json({
            items: serializedTrades,
            total
        })
    } catch (error) {
        console.error("Failed to fetch trades:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
