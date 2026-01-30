"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Activity, Database, Timer, TriangleAlert } from "lucide-react"

interface StatusResponse {
    health: { status: string }
    services: {
        worker: "ok" | "degraded" | "unhealthy" | "down"
        database: "ok" | "down"
        redis: "ok" | "down" | "unknown"
        websocket: "ok" | "degraded" | "down"
    }
    worker: {
        lastCanonicalEventTime: string | null
        wsConnected: boolean | null
        dbConnected: boolean | null
    }
    ingestion: {
        lastTradeEventTime: number | null
        lastActivityEventTime: number | null
        lastBackfillTime: number | null
        lastBlock: number | null
    }
    snapshots: {
        lastSnapshotTime: number | null
        lastGlobalSnapshotTime: number | null
    }
    queues: {
        ingest: number | null
        group: number | null
        copyUser: number | null
        copyGlobal: number | null
        apply: number | null
        reconcile: number | null
        prices: number | null
        dlq: number | null
    }
    apiErrors: {
        polymarket: number | null
        alchemy: number | null
    }
    database: {
        sizeBytes: number | null
        counts: {
            trades: number
            activities: number
            copyAttempts: number
            ledgerEntries: number
            snapshots: number
        }
    }
}

const formatTime = (value: number | null) =>
    value ? new Date(value).toLocaleString() : "--"

const formatAgo = (value: number | null) => {
    if (!value) return "--"
    const diffMs = Date.now() - value
    const seconds = Math.max(0, Math.floor(diffMs / 1000))
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

const formatBytes = (value: number | null) => {
    if (!value) return "--"
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function SummaryTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">{label}</div>
            <div className="mt-2 text-lg font-semibold text-white">{value}</div>
            {hint ? <div className="mt-1 text-xs text-[#6f6f6f]">{hint}</div> : null}
        </div>
    )
}

function StatusPill({ value }: { value: string }) {
    const tone =
        value === "ok"
            ? "bg-[#102b1a] text-[#86efac]"
            : value === "degraded" || value === "unknown"
              ? "bg-[#2b2312] text-amber-400"
              : "bg-[#2b1212] text-[#f87171]"
    return <span className={`rounded-full px-2 py-1 text-xs font-semibold ${tone}`}>{value}</span>
}

function ServiceCard({
    label,
    status,
    detail
}: {
    label: string
    status: string
    detail?: string
}) {
    return (
        <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
            <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">{label}</div>
                <StatusPill value={status} />
            </div>
            {detail ? <div className="mt-2 text-xs text-[#6f6f6f]">{detail}</div> : null}
        </div>
    )
}

export default function StatusPage() {
    const { data: status, error, isLoading } = useSWR<StatusResponse>(
        "/api/status",
        fetcher,
        { refreshInterval: 10000 }
    )

    return (
        <div className="relative w-full bg-black text-white overflow-hidden min-h-dvh md:h-screen">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-6 pt-20 md:pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
                        <div>
                            <p className="text-sm text-[#6f6f6f]">System</p>
                            <h1 className="text-2xl md:text-3xl font-bold">Status & Health</h1>
                        </div>

                        {isLoading ? (
                            <div className="text-gray-400">Loading status...</div>
                        ) : error ? (
                            <div className="text-red-500">Failed to load system status</div>
                        ) : (
                            <div className="flex flex-col gap-6">
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                    <ServiceCard
                                        label="Worker"
                                        status={status?.services.worker ?? "down"}
                                        detail={
                                            status?.worker.lastCanonicalEventTime
                                                ? `Last event ${formatAgo(
                                                      new Date(status.worker.lastCanonicalEventTime).getTime()
                                                  )}`
                                                : "No event signal"
                                        }
                                    />
                                    <ServiceCard
                                        label="Database"
                                        status={status?.services.database ?? "down"}
                                        detail={`Size ${formatBytes(status?.database.sizeBytes ?? null)}`}
                                    />
                                    <ServiceCard
                                        label="Redis"
                                        status={status?.services.redis ?? "down"}
                                        detail={
                                            status?.queues.ingest !== null
                                                ? `Queues ${status?.queues.ingest ?? 0} waiting`
                                                : status?.services.redis === "unknown"
                                                  ? "REDIS_URL missing"
                                                  : "Queue stats unavailable"
                                        }
                                    />
                                    <ServiceCard
                                        label="Websocket"
                                        status={status?.services.websocket ?? "down"}
                                        detail={
                                            status?.worker.wsConnected === null
                                                ? "Worker health not reachable"
                                                : status?.worker.wsConnected
                                                  ? "Alchemy connected"
                                                  : "WS disconnected"
                                        }
                                    />
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                    <SummaryTile
                                        label="Last Trade Event"
                                        value={formatAgo(status?.ingestion.lastTradeEventTime ?? null)}
                                        hint={formatTime(status?.ingestion.lastTradeEventTime ?? null)}
                                    />
                                    <SummaryTile
                                        label="Last Activity Event"
                                        value={formatAgo(status?.ingestion.lastActivityEventTime ?? null)}
                                        hint={formatTime(status?.ingestion.lastActivityEventTime ?? null)}
                                    />
                                    <SummaryTile
                                        label="Last Backfill"
                                        value={formatAgo(status?.ingestion.lastBackfillTime ?? null)}
                                        hint={formatTime(status?.ingestion.lastBackfillTime ?? null)}
                                    />
                                    <SummaryTile
                                        label="Global Snapshot"
                                        value={formatAgo(status?.snapshots.lastGlobalSnapshotTime ?? null)}
                                        hint={formatTime(status?.snapshots.lastGlobalSnapshotTime ?? null)}
                                    />
                                </div>

                                <div className="grid grid-cols-1 xl:grid-cols-[1.25fr_1fr] gap-6">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <Timer className="h-4 w-4 text-[#86efac]" />
                                            Ingestion Checkpoints
                                        </div>
                                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Last Block
                                                </div>
                                                <div className="mt-2 text-lg font-semibold text-white">
                                                    {status?.ingestion.lastBlock ?? "--"}
                                                </div>
                                            </div>
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Snapshot Freshness
                                                </div>
                                                <div className="mt-2 text-lg font-semibold text-white">
                                                    {formatAgo(status?.snapshots.lastSnapshotTime ?? null)}
                                                </div>
                                                <div className="text-xs text-[#6f6f6f]">
                                                    {formatTime(status?.snapshots.lastSnapshotTime ?? null)}
                                                </div>
                                            </div>
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Trade Events
                                                </div>
                                                <div className="mt-2 text-lg font-semibold text-white">
                                                    {status?.database.counts.trades ?? 0}
                                                </div>
                                            </div>
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Activity Events
                                                </div>
                                                <div className="mt-2 text-lg font-semibold text-white">
                                                    {status?.database.counts.activities ?? 0}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <Activity className="h-4 w-4 text-[#86efac]" />
                                            Queues & DLQ
                                        </div>
                                        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                                            {[
                                                ["Ingest", status?.queues.ingest],
                                                ["Group", status?.queues.group],
                                                ["Copy User", status?.queues.copyUser],
                                                ["Copy Global", status?.queues.copyGlobal],
                                                ["Apply", status?.queues.apply],
                                                ["Reconcile", status?.queues.reconcile],
                                                ["Prices", status?.queues.prices],
                                                ["DLQ", status?.queues.dlq]
                                            ].map(([label, value]) => (
                                                <div
                                                    key={label}
                                                    className="rounded-xl border border-[#27272A] bg-[#111111] p-3"
                                                >
                                                    <div className="text-xs text-[#6f6f6f]">{label}</div>
                                                    <div className="mt-1 text-base font-semibold text-white">
                                                        {value ?? "--"}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="mt-3 text-xs text-[#6f6f6f]">
                                            Queue depths are pulled from the worker health endpoint.
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_1fr] gap-6">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <Database className="h-4 w-4 text-[#86efac]" />
                                            Database Footprint
                                        </div>
                                        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4">
                                            <SummaryTile
                                                label="DB Size"
                                                value={formatBytes(status?.database.sizeBytes ?? null)}
                                            />
                                            <SummaryTile
                                                label="Copy Attempts"
                                                value={`${status?.database.counts.copyAttempts ?? 0}`}
                                            />
                                            <SummaryTile
                                                label="Ledger Entries"
                                                value={`${status?.database.counts.ledgerEntries ?? 0}`}
                                            />
                                            <SummaryTile
                                                label="Snapshots"
                                                value={`${status?.database.counts.snapshots ?? 0}`}
                                            />
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <TriangleAlert className="h-4 w-4 text-amber-400" />
                                            API Error Rates
                                        </div>
                                        <div className="mt-4 grid grid-cols-2 gap-4">
                                            <SummaryTile
                                                label="Polymarket"
                                                value={
                                                    status?.apiErrors?.polymarket != null
                                                        ? `${status.apiErrors.polymarket}%`
                                                        : "--"
                                                }
                                            />
                                            <SummaryTile
                                                label="Alchemy"
                                                value={
                                                    status?.apiErrors?.alchemy != null
                                                        ? `${status.apiErrors.alchemy}%`
                                                        : "--"
                                                }
                                            />
                                        </div>
                                        <div className="mt-3 text-xs text-[#6f6f6f]">
                                            Error rates require request logging; placeholders until wired.
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </main>
            </div>
        </div>
    )
}
