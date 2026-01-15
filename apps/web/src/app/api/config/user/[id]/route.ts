import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const json = await request.json()
        const { guardrails, sizing } = json
        const { id: userId } = await params

        // Verify user exists
        const user = await prisma.followedUser.findUnique({ where: { id: userId } })
        if (!user) {
            return NextResponse.json({ error: "User not found" }, { status: 404 })
        }

        // Update User Guardrails
        if (guardrails) {
            const existing = await prisma.guardrailConfig.findFirst({
                where: { scope: "USER", followedUserId: userId }
            })

            if (existing) {
                await prisma.guardrailConfig.update({
                    where: { id: existing.id },
                    data: { configJson: guardrails }
                })
            } else {
                await prisma.guardrailConfig.create({
                    data: {
                        scope: "USER",
                        followedUserId: userId,
                        configJson: guardrails
                    }
                })
            }
        }

        // Update User Sizing
        if (sizing) {
            const existing = await prisma.copySizingConfig.findFirst({
                where: { scope: "USER", followedUserId: userId }
            })

            if (existing) {
                await prisma.copySizingConfig.update({
                    where: { id: existing.id },
                    data: { configJson: sizing }
                })
            } else {
                await prisma.copySizingConfig.create({
                    data: {
                        scope: "USER",
                        followedUserId: userId,
                        configJson: sizing
                    }
                })
            }
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error("Failed to update user config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const { id: userId } = await params
        const guardrails = await prisma.guardrailConfig.findFirst({
            where: { scope: "USER", followedUserId: userId }
        })
        const sizing = await prisma.copySizingConfig.findFirst({
            where: { scope: "USER", followedUserId: userId }
        })

        return NextResponse.json({
            guardrails: guardrails?.configJson || {},
            sizing: sizing?.configJson || {}
        })
    } catch (error) {
        console.error("Failed to fetch user config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
