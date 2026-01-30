import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

function parseTradeGroupKey(groupKey: string): {
    followedUserId: string | null
    tokenId: string | null
} {
    // Format (trade): <followedUserId>:<tokenId>:<side>:<windowStartIso>
    const parts = groupKey.split(":")
    if (parts.length < 4) return { followedUserId: null, tokenId: null }
    const followedUserId = parts[0] ?? null
    const tokenId = parts[1] ?? null
    const side = parts[2]
    if (side !== "BUY" && side !== "SELL") return { followedUserId: null, tokenId: null }
    return { followedUserId, tokenId }
}

export async function GET(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get("limit") || "50")
    const decision = searchParams.get("decision") // EXECUTE or SKIP
    const assetId = searchParams.get("assetId")
    const cursor = searchParams.get("cursor")

    try {
        const where = {
            portfolioScope: "EXEC_GLOBAL" as const,
            ...(decision && { decision: decision as any }),
            ...(assetId && { groupKey: { contains: `:${assetId}:` } })
        }

        const [total, attempts] = await Promise.all([
            prisma.copyAttempt.count({ where }),
            prisma.copyAttempt.findMany({
                where,
                include: {
                    followedUser: {
                        select: { label: true }
                    },
                    fills: true
                },
                take: limit,
                skip: cursor ? 1 : 0,
                cursor: cursor ? { id: cursor } : undefined,
                orderBy: [
                    { createdAt: 'desc' },
                    { id: 'desc' }
                ]
            })
        ])

        const refIds = attempts.map((attempt) => `copy:${attempt.id}`)
        const ledgerEntries = await prisma.ledgerEntry.findMany({
            where: {
                refId: { in: refIds },
                entryType: "TRADE_FILL"
            },
            select: {
                refId: true,
                marketId: true,
                assetId: true
            }
        })

        const ledgerMap = new Map(ledgerEntries.map((entry) => [entry.refId, entry]))

        const enrichedAttempts = attempts.map((attempt) => {
            const ledger = ledgerMap.get(`copy:${attempt.id}`)
            const parsed = parseTradeGroupKey(attempt.groupKey)
            const derivedFollowedUserId = attempt.followedUserId ?? parsed.followedUserId
            const derivedAssetId = ledger?.assetId ?? parsed.tokenId ?? null
            return {
                ...attempt,
                followedUserId: derivedFollowedUserId,
                marketId: ledger?.marketId ?? null,
                assetId: derivedAssetId
            }
        })

        const missingFollowedUserIds = Array.from(
            new Set(
                enrichedAttempts
                    .filter((attempt) => !attempt.followedUser?.label && attempt.followedUserId)
                    .map((attempt) => attempt.followedUserId)
                    .filter((id): id is string => Boolean(id))
            )
        )
        const followedUsers = missingFollowedUserIds.length
            ? await prisma.followedUser.findMany({
                  where: { id: { in: missingFollowedUserIds } },
                  select: { id: true, label: true }
              })
            : []
        const followedUserMap = new Map(followedUsers.map((u) => [u.id, u.label]))

        const tokenIds = Array.from(
            new Set(
                enrichedAttempts
                    .map((attempt) => attempt.assetId)
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

        const serializedAttempts = enrichedAttempts.map((attempt) => ({
            marketTitle:
                attempt.assetId
                    ? tokenMetadataMap.get(attempt.assetId)?.marketTitle ?? null
                    : null,
            marketSlug:
                attempt.assetId
                    ? tokenMetadataMap.get(attempt.assetId)?.marketSlug ?? null
                    : null,
            outcomeLabel:
                attempt.assetId
                    ? tokenMetadataMap.get(attempt.assetId)?.outcomeLabel ?? null
                    : null,
            ...attempt,
            followedUser: attempt.followedUser?.label
                ? attempt.followedUser
                : attempt.followedUserId
                  ? { label: followedUserMap.get(attempt.followedUserId) ?? null }
                  : null,
            targetNotionalMicros: attempt.targetNotionalMicros.toString(),
            filledNotionalMicros: attempt.filledNotionalMicros.toString(),
            fills: attempt.fills.map((fill) => ({
                ...fill,
                filledShareMicros: fill.filledShareMicros.toString(),
                fillNotionalMicros: fill.fillNotionalMicros.toString()
            }))
        }))

        return NextResponse.json({
            items: serializedAttempts,
            total
        })
    } catch (error) {
        console.error("Failed to fetch copy attempts:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
