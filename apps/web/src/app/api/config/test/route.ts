import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function POST(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const body = await request.json()
        const scope = body?.scope === "USER" ? "USER" : "GLOBAL"
        const userId = body?.userId

        const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
        const where: Record<string, any> = {
            createdAt: { gte: since }
        }

        if (scope === "GLOBAL") {
            where.portfolioScope = "EXEC_GLOBAL"
        } else {
            where.portfolioScope = "EXEC_USER"
            if (userId) {
                where.followedUserId = userId
            }
        }

        const total = await prisma.copyAttempt.count({ where })
        const executed = await prisma.copyAttempt.count({
            where: { ...where, decision: "EXECUTE" }
        })
        const skipped = total - executed

        return NextResponse.json({ total, executed, skipped })
    } catch (error) {
        console.error("Failed to test config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
