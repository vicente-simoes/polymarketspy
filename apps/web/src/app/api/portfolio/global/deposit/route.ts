import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { randomUUID } from "crypto"
import { LedgerEntryType } from "@prisma/client"

function parseUsdToMicros(value: unknown): number | null {
    const parsed =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseFloat(value)
              : Number.NaN

    if (!Number.isFinite(parsed) || parsed <= 0) return null
    const micros = Math.round(parsed * 1_000_000)
    if (!Number.isFinite(micros) || micros <= 0) return null
    return micros
}

export async function POST(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const body = (await request.json().catch(() => null)) as
            | { amountUsd?: unknown }
            | null

        const amountMicros = parseUsdToMicros(body?.amountUsd)
        if (!amountMicros) {
            return NextResponse.json({ error: "Invalid amountUsd" }, { status: 400 })
        }

        const refId = `deposit:${randomUUID()}`

        await prisma.ledgerEntry.create({
            data: {
                portfolioScope: "EXEC_GLOBAL",
                followedUserId: null,
                marketId: null,
                assetId: null,
                entryType: LedgerEntryType.DEPOSIT,
                shareDeltaMicros: BigInt(0),
                cashDeltaMicros: BigInt(amountMicros),
                priceMicros: null,
                refId
            }
        })

        return NextResponse.json({ ok: true })
    } catch (error) {
        console.error("Failed to deposit cash:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
