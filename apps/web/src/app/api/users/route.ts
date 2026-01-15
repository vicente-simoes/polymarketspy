import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export const dynamic = 'force-dynamic'

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const users = await prisma.followedUser.findMany({
            include: {
                proxies: true,
                _count: {
                    select: { copyAttempts: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        })

        // Fetch latest snapshots for all users
        const userIds = users.map((u: { id: string }) => u.id);
        const snapshots = await prisma.portfolioSnapshot.findMany({
            where: {
                followedUserId: { in: userIds },
                portfolioScope: { in: ['SHADOW_USER', 'EXEC_USER'] }
            },
            orderBy: { bucketTime: 'desc' },
            distinct: ['portfolioScope', 'followedUserId']
        })

        const usersWithMetrics = users.map((user: any) => {
            const shadowSnap = snapshots.find((s: any) => s.followedUserId === user.id && s.portfolioScope === 'SHADOW_USER')
            const execSnap = snapshots.find((s: any) => s.followedUserId === user.id && s.portfolioScope === 'EXEC_USER')

            return {
                ...user,
                metrics: {
                    shadowEquity: shadowSnap ? Number(shadowSnap.equityMicros) / 1_000_000 : 0,
                    execEquity: execSnap ? Number(execSnap.equityMicros) / 1_000_000 : 0,
                    execRealizedPnl: execSnap ? Number(execSnap.realizedPnlMicros) / 1_000_000 : 0,
                    execUnrealizedPnl: execSnap ? Number(execSnap.unrealizedPnlMicros) / 1_000_000 : 0,
                }
            }
        })

        return NextResponse.json(usersWithMetrics)
    } catch (error) {
        console.error("Failed to fetch users:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
