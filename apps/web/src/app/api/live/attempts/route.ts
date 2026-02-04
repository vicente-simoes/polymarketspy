import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

function parseTradeGroupKey(groupKey: string): { followedUserId: string | null; tokenId: string | null } {
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
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200)
    const decision = searchParams.get("decision") // EXECUTE | SKIP
    const tokenId = searchParams.get("tokenId")
    const cursor = searchParams.get("cursor")

    try {
        const where = {
            tradingMode: "LIVE" as const,
            portfolioScope: "EXEC_GLOBAL" as const,
            ...(decision ? { decision: decision as any } : {}),
            ...(tokenId ? { groupKey: { contains: `:${tokenId}:` } } : {}),
        }

        const [total, attempts] = await Promise.all([
            prisma.copyAttempt.count({ where }),
            prisma.copyAttempt.findMany({
                where,
                include: {
                    followedUser: { select: { label: true } },
                    liveOrder: {
                        select: { id: true, status: true, clobOrderId: true, lastErrorCode: true, lastErrorMessage: true },
                    },
                },
                take: limit,
                skip: cursor ? 1 : 0,
                cursor: cursor ? { id: cursor } : undefined,
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            }),
        ])

        const enriched = attempts.map((attempt) => {
            const parsed = parseTradeGroupKey(attempt.groupKey)
            const derivedFollowedUserId = attempt.followedUserId ?? parsed.followedUserId
            const derivedTokenId = parsed.tokenId ?? null
            return { ...attempt, followedUserId: derivedFollowedUserId, tokenId: derivedTokenId }
        })

        const tokenIds = Array.from(new Set(enriched.map((a) => a.tokenId).filter((v): v is string => Boolean(v))))
        const metas = tokenIds.length
            ? await prisma.tokenMetadataCache.findMany({
                  where: { tokenId: { in: tokenIds } },
                  select: { tokenId: true, marketTitle: true, marketSlug: true, outcomeLabel: true },
              })
            : []
        const metaByToken = new Map(metas.map((m) => [m.tokenId, m]))

        const items = enriched.map((attempt) => {
            const meta = attempt.tokenId ? metaByToken.get(attempt.tokenId) : null
            return {
                ...attempt,
                marketTitle: meta?.marketTitle ?? null,
                marketSlug: meta?.marketSlug ?? null,
                outcomeLabel: meta?.outcomeLabel ?? null,
                targetNotionalMicros: attempt.targetNotionalMicros.toString(),
                filledNotionalMicros: attempt.filledNotionalMicros.toString(),
            }
        })

        return NextResponse.json({ items, total }, { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        console.error("Failed to fetch live attempts:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

