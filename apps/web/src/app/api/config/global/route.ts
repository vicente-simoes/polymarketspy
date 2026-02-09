import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { TradingMode } from "@prisma/client"

export const dynamic = "force-dynamic"

const SYSTEM_CONFIG_KEY = "system:config"
const LEGACY_SMALL_TRADE_BUFFERING_KEY = "config:smallTradeBuffering"
const DEFAULT_INITIAL_BANKROLL_MICROS = 100_000_000 // $100
const DEFAULT_COPY_ENGINE_ENABLED = true
const DEFAULT_PAPER_TRADING_ENABLED = true
const DEFAULT_LIVE_TRADING_ENABLED = false
const DEFAULT_LIVE_TRADING_READ_ONLY_ENABLED = false

function parseTradingMode(request: Request): TradingMode {
    try {
        const url = new URL(request.url)
        const raw = url.searchParams.get("mode")
        if (raw === TradingMode.LIVE) return TradingMode.LIVE
        return TradingMode.PAPER
    } catch {
        return TradingMode.PAPER
    }
}

function smallTradeBufferingKey(mode: TradingMode): string {
    return `config:smallTradeBuffering:${mode}`
}

export async function POST(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const tradingMode = parseTradingMode(request)
        const json = await request.json()
        const { guardrails, sizing, system, smallTradeBuffering } = json

        // Update Global Guardrails
        if (guardrails) {
            // NOTE: We may have multiple rows due to missing DB uniqueness constraints.
            // Always update ALL matching rows to keep reads consistent.
            const result = await prisma.guardrailConfig.updateMany({
                where: { scope: "GLOBAL", tradingMode: tradingMode, followedUserId: null },
                data: { configJson: guardrails }
            })

            if (result.count === 0) {
                await prisma.guardrailConfig.create({
                    data: {
                        scope: "GLOBAL",
                        tradingMode: tradingMode,
                        followedUserId: null,
                        configJson: guardrails
                    }
                })
            }
        }

        // Update Global Sizing
        if (sizing) {
            const result = await prisma.copySizingConfig.updateMany({
                where: { scope: "GLOBAL", tradingMode: tradingMode, followedUserId: null },
                data: { configJson: sizing }
            })

            if (result.count === 0) {
                await prisma.copySizingConfig.create({
                    data: {
                        scope: "GLOBAL",
                        tradingMode: tradingMode,
                        followedUserId: null,
                        configJson: sizing
                    }
                })
            }
        }

        // Update System Config
        if (system && typeof system === "object") {
            const systemUpdates: Record<string, any> = {}

            if ("initialBankrollMicros" in (system as any)) {
                const initialBankrollMicrosRaw = (system as any).initialBankrollMicros
                const initialBankrollMicros =
                    typeof initialBankrollMicrosRaw === "number" &&
                    Number.isFinite(initialBankrollMicrosRaw)
                        ? Math.max(0, Math.floor(initialBankrollMicrosRaw))
                        : null
                if (initialBankrollMicros !== null) {
                    systemUpdates.initialBankrollMicros = initialBankrollMicros
                }
            }

            const copyEngineEnabledRaw = (system as any).copyEngineEnabled
            if (typeof copyEngineEnabledRaw === "boolean") {
                systemUpdates.copyEngineEnabled = copyEngineEnabledRaw
            }
            const paperTradingEnabledRaw = (system as any).paperTradingEnabled
            if (typeof paperTradingEnabledRaw === "boolean") {
                systemUpdates.paperTradingEnabled = paperTradingEnabledRaw
            }
            const liveTradingEnabledRaw = (system as any).liveTradingEnabled
            if (typeof liveTradingEnabledRaw === "boolean") {
                systemUpdates.liveTradingEnabled = liveTradingEnabledRaw
            }
            const liveTradingReadOnlyEnabledRaw = (system as any).liveTradingReadOnlyEnabled
            if (typeof liveTradingReadOnlyEnabledRaw === "boolean") {
                systemUpdates.liveTradingReadOnlyEnabled = liveTradingReadOnlyEnabledRaw
            }

            if (Object.keys(systemUpdates).length > 0) {
                const existing = await prisma.systemCheckpoint.findUnique({
                    where: { key: SYSTEM_CONFIG_KEY }
                })
                const existingJson = (existing?.valueJson || {}) as Record<string, any>
                const nextJson = {
                    ...existingJson,
                    ...systemUpdates
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

        // Update Small Trade Buffering Config
        if (smallTradeBuffering && typeof smallTradeBuffering === "object") {
            const bufferingKey = smallTradeBufferingKey(tradingMode)
            await prisma.systemCheckpoint.upsert({
                where: { key: bufferingKey },
                create: {
                    key: bufferingKey,
                    valueJson: smallTradeBuffering
                },
                update: {
                    valueJson: smallTradeBuffering
                }
            })
        }

        return NextResponse.json(
            { success: true },
            { headers: { "Cache-Control": "no-store" } }
        )
    } catch (error) {
        console.error("Failed to update global config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function GET(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const tradingMode = parseTradingMode(request)

        // Use deterministic ordering in case duplicates exist.
        const guardrails = await prisma.guardrailConfig.findFirst({
            where: { scope: "GLOBAL", tradingMode: tradingMode, followedUserId: null },
            orderBy: { updatedAt: "desc" }
        })
        const sizing = await prisma.copySizingConfig.findFirst({
            where: { scope: "GLOBAL", tradingMode: tradingMode, followedUserId: null },
            orderBy: { updatedAt: "desc" }
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
        const copyEngineEnabled =
            typeof systemJson.copyEngineEnabled === "boolean"
                ? systemJson.copyEngineEnabled
                : DEFAULT_COPY_ENGINE_ENABLED
        const paperTradingEnabled =
            typeof systemJson.paperTradingEnabled === "boolean"
                ? systemJson.paperTradingEnabled
                : DEFAULT_PAPER_TRADING_ENABLED
        const liveTradingEnabled =
            typeof systemJson.liveTradingEnabled === "boolean"
                ? systemJson.liveTradingEnabled
                : DEFAULT_LIVE_TRADING_ENABLED
        const liveTradingReadOnlyEnabled =
            typeof systemJson.liveTradingReadOnlyEnabled === "boolean"
                ? systemJson.liveTradingReadOnlyEnabled
                : DEFAULT_LIVE_TRADING_READ_ONLY_ENABLED

        // Load small trade buffering config
        const bufferingKey = smallTradeBufferingKey(tradingMode)
        const bufferingRow = await prisma.systemCheckpoint.findUnique({ where: { key: bufferingKey } })
        let smallTradeBuffering = (bufferingRow?.valueJson || {}) as Record<string, any>
        if (!bufferingRow && tradingMode === TradingMode.PAPER) {
            const legacyRow = await prisma.systemCheckpoint.findUnique({
                where: { key: LEGACY_SMALL_TRADE_BUFFERING_KEY }
            })
            smallTradeBuffering = (legacyRow?.valueJson || {}) as Record<string, any>
        }

        return NextResponse.json(
            {
                tradingMode,
                guardrails: guardrails?.configJson || {},
                sizing: sizing?.configJson || {},
                system: {
                    initialBankrollMicros,
                    copyEngineEnabled,
                    paperTradingEnabled,
                    liveTradingEnabled,
                    liveTradingReadOnlyEnabled,
                },
                smallTradeBuffering
            },
            { headers: { "Cache-Control": "no-store" } }
        )
    } catch (error) {
        console.error("Failed to fetch global config:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
