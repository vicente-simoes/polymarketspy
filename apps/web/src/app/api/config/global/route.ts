import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

const SYSTEM_CONFIG_KEY = "system:config"
const DEFAULT_INITIAL_BANKROLL_MICROS = 100_000_000 // $100

export async function POST(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const json = await request.json()
        const { guardrails, sizing, system } = json

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

        // Update System Config
        if (system && typeof system === "object") {
            const initialBankrollMicrosRaw = (system as any).initialBankrollMicros
            const initialBankrollMicros =
                typeof initialBankrollMicrosRaw === "number" &&
                Number.isFinite(initialBankrollMicrosRaw)
                    ? Math.max(0, Math.floor(initialBankrollMicrosRaw))
                    : null

            if (initialBankrollMicros !== null) {
                const existing = await prisma.systemCheckpoint.findUnique({
                    where: { key: SYSTEM_CONFIG_KEY }
                })
                const existingJson = (existing?.valueJson || {}) as Record<string, any>
                const nextJson = {
                    ...existingJson,
                    initialBankrollMicros
                }

                await prisma.systemCheckpoint.upsert({
                    where: { key: SYSTEM_CONFIG_KEY },
                    create: {
                        key: SYSTEM_CONFIG_KEY,
                        valueJson: nextJson
                    },
                    update: {
                        valueJson: nextJson
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

        const systemRow = await prisma.systemCheckpoint.findUnique({
            where: { key: SYSTEM_CONFIG_KEY }
        })
        const systemJson = (systemRow?.valueJson || {}) as Record<string, any>
        const initialBankrollMicros =
            typeof systemJson.initialBankrollMicros === "number" &&
            Number.isFinite(systemJson.initialBankrollMicros)
                ? Math.max(0, Math.floor(systemJson.initialBankrollMicros))
                : DEFAULT_INITIAL_BANKROLL_MICROS

        return NextResponse.json({
            guardrails: guardrails?.configJson || {},
            sizing: sizing?.configJson || {},
            system: {
                initialBankrollMicros
            }
        })
    } catch (error) {
        console.error("Failed to fetch global config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
