import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { LiveOrderStatus, LiveOverride } from "@prisma/client"

type WorkerHealthLive = {
    liveReconciliation?: {
        enabled: boolean
        isHealthy: boolean
        isInitialized: boolean
        lastOrderReconcileAt: string | null
        lastStateReconcileAt: string | null
        submissionUnknownCount: number
    }
    userChannel?: {
        enabled: boolean
        connected: boolean
        lastConnectedAt: string | null
        lastMessageAt: string | null
        errorCount: number
        orphanBufferSize: number
    }
    clobBook?: { wsConnected: boolean }
}

const SYSTEM_CONFIG_KEY = "system:config"

function parseBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback
}

async function fetchWorkerHealth(): Promise<WorkerHealthLive | null> {
    const workerUrl =
        process.env.WORKER_HEALTH_URL ??
        (process.env.NODE_ENV === "development"
            ? "http://localhost:8081/health"
            : "http://worker:8081/health")

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 1500)
        const response = await fetch(workerUrl, { signal: controller.signal })
        clearTimeout(timeout)
        if (!response.ok) return null
        return (await response.json()) as WorkerHealthLive
    } catch {
        return null
    }
}

export async function GET(_request: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const [
            workerHealth,
            systemRow,
            overrideCounts,
            disabledUserCount,
            orderStatusCounts,
            lastErrorOrder,
            lastFill,
            lastAttempt,
        ] = await Promise.all([
            fetchWorkerHealth(),
            prisma.systemCheckpoint.findUnique({
                where: { key: SYSTEM_CONFIG_KEY },
                select: { valueJson: true, updatedAt: true },
            }),
            prisma.followedUser.groupBy({
                by: ["liveOverride"],
                where: { enabled: true },
                _count: { _all: true },
            }),
            prisma.followedUser.count({ where: { enabled: false } }),
            prisma.liveOrder.groupBy({
                by: ["status"],
                _count: { _all: true },
            }),
            prisma.liveOrder.findFirst({
                where: {
                    OR: [{ lastErrorMessage: { not: null } }, { lastErrorCode: { not: null } }],
                },
                orderBy: [{ lastUpdateAt: "desc" }, { createdAt: "desc" }],
                select: {
                    id: true,
                    status: true,
                    lastErrorCode: true,
                    lastErrorMessage: true,
                    lastUpdateAt: true,
                    createdAt: true,
                },
            }),
            prisma.liveFill.findFirst({
                orderBy: [{ matchedAt: "desc" }, { id: "desc" }],
                select: { matchedAt: true },
            }),
            prisma.copyAttempt.findFirst({
                where: { tradingMode: "LIVE" },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                select: { createdAt: true },
            }),
        ])

        const systemJson = (systemRow?.valueJson || {}) as Record<string, unknown>
        const liveTradingEnabled = parseBoolean(systemJson.liveTradingEnabled, false)
        const liveTradingReadOnlyEnabled = parseBoolean(systemJson.liveTradingReadOnlyEnabled, false)
        const copyEngineEnabled = parseBoolean(systemJson.copyEngineEnabled, true)

        const overrides = {
            [LiveOverride.INHERIT]: 0,
            [LiveOverride.FORCE_ON]: 0,
            [LiveOverride.FORCE_OFF]: 0,
            disabled: disabledUserCount,
        }
        for (const row of overrideCounts) {
            overrides[row.liveOverride] = row._count._all
        }

        const statusCounts = new Map<string, number>(
            orderStatusCounts.map((row) => [row.status, row._count._all])
        )

        const openStatuses: LiveOrderStatus[] = [
            LiveOrderStatus.CREATED,
            LiveOrderStatus.SUBMITTING,
            LiveOrderStatus.OPEN,
            LiveOrderStatus.PARTIAL,
        ]

        const openOrdersCount = openStatuses.reduce((acc, status) => acc + (statusCounts.get(status) ?? 0), 0)
        const submissionUnknownCount = statusCounts.get(LiveOrderStatus.SUBMISSION_UNKNOWN) ?? 0

        return NextResponse.json(
            {
                system: {
                    copyEngineEnabled,
                    liveTradingEnabled,
                    liveTradingReadOnlyEnabled,
                    updatedAt: systemRow?.updatedAt?.getTime() ?? null,
                },
                followedUsers: {
                    overrides,
                },
                worker: {
                    userChannel: workerHealth?.userChannel ?? null,
                    liveReconciliation: workerHealth?.liveReconciliation ?? null,
                    clobBookWsConnected: workerHealth?.clobBook?.wsConnected ?? null,
                },
                liveOrders: {
                    countsByStatus: Object.fromEntries(statusCounts),
                    openOrdersCount,
                    submissionUnknownCount,
                    lastError: lastErrorOrder
                        ? {
                              liveOrderId: lastErrorOrder.id,
                              status: lastErrorOrder.status,
                              code: lastErrorOrder.lastErrorCode,
                              message: lastErrorOrder.lastErrorMessage,
                              at: (lastErrorOrder.lastUpdateAt ?? lastErrorOrder.createdAt).getTime(),
                          }
                        : null,
                },
                liveFills: {
                    lastMatchedAt: lastFill?.matchedAt?.getTime() ?? null,
                },
                liveAttempts: {
                    lastAttemptAt: lastAttempt?.createdAt?.getTime() ?? null,
                },
            },
            { headers: { "Cache-Control": "no-store" } }
        )
    } catch (error) {
        console.error("Failed to fetch live status:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

