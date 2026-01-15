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
        const json = await request.json()
        const { guardrails, sizing } = json

        // Update Global Guardrails
        if (guardrails) {
            // Find existing global config or create
            const existing = await prisma.guardrailConfig.findFirst({
                where: { scope: "GLOBAL" }
            })

            if (existing) {
                await prisma.guardrailConfig.update({
                    where: { id: existing.id },
                    data: { configJson: guardrails }
                })
            } else {
                await prisma.guardrailConfig.create({
                    data: {
                        scope: "GLOBAL",
                        configJson: guardrails
                    }
                })
            }
        }

        // Update Global Sizing
        if (sizing) {
            const existing = await prisma.copySizingConfig.findFirst({
                where: { scope: "GLOBAL" }
            })

            if (existing) {
                await prisma.copySizingConfig.update({
                    where: { id: existing.id },
                    data: { configJson: sizing }
                })
            } else {
                await prisma.copySizingConfig.create({
                    data: {
                        scope: "GLOBAL",
                        configJson: sizing
                    }
                })
            }
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error("Failed to update global config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const guardrails = await prisma.guardrailConfig.findFirst({
            where: { scope: "GLOBAL" }
        })
        const sizing = await prisma.copySizingConfig.findFirst({
            where: { scope: "GLOBAL" }
        })

        return NextResponse.json({
            guardrails: guardrails?.configJson || {},
            sizing: sizing?.configJson || {}
        })
    } catch (error) {
        console.error("Failed to fetch global config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
