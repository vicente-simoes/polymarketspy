"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { use } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import {
    Activity,
    ArrowLeft,
    BarChart3,
    ExternalLink,
    TrendingDown,
    TrendingUp
} from "lucide-react"
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from "recharts"

interface UserDetailResponse {
    id: string
    label: string
    profileWallet: string
    enabled: boolean
    proxies: { id: string; wallet: string }[]
    metrics: {
        shadowEquity: number
        execEquity: number
        execRealizedPnl: number
        execUnrealizedPnl: number
        execExposure: number
        lastSnapshotTs: number | null
    }
    equityCurve: { ts: number; shadow: number; exec: number; gap: number }[]
    attemptStats: {
        totalAttempts: number
        executedAttempts: number
        skippedAttempts: number
        partialAttempts: number
        attemptRate: number
        fillRate: number
        partialRate: number
    }
    slippageHistogram: { bucket: string; count: number }[]
    lagHistogram: { bucket: string; count: number }[]
    skipReasons: { reason: string; count: number }[]
    positions: {
        shadow: {
            assetId: string
            shares: number
            invested: number
            marketTitle: string
            outcome: string
        }[]
        exec: {
            assetId: string
            shares: number
            invested: number
            marketTitle: string
            outcome: string
        }[]
    }
    recentTrades: {
        id: string
        side: string
        marketId: string | null
        assetId: string | null
        price: number
        shares: number
        notional: number
        eventTime: number
    }[]
    recentAttempts: {
        id: string
        decision: string
        reasonCodes: string[]
        targetNotional: number
        filledNotional: number
        filledRatioBps: number
        vwapPrice: number | null
        theirReferencePrice: number
        createdAt: number
    }[]
    budgetedDynamic: {
        enabled: boolean
        sizingMode: string
        budgetUsd: number
        leaderExposureUsd: number
        currentCopyExposureUsd: number
        effectiveRatePct: number
        headroomUsd: number
        budgetEnforcement: string
        rMinPct: number
        rMaxPct: number
    }
}

const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2
    }).format(value)

const formatPercent = (value: number) => `${value.toFixed(1)}%`

const formatWallet = (wallet: string) =>
    `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}`

const formatDateTime = (ts: number) =>
    new Date(ts).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    })

const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit"
    })

function MetricTile({
    label,
    value,
    hint,
    valueClassName
}: {
    label: string
    value: string
    hint?: string
    valueClassName?: string
}) {
    return (
        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">{label}</div>
            <div className={`mt-2 text-2xl font-semibold ${valueClassName ?? "text-white"}`}>
                {value}
            </div>
            {hint ? <div className="mt-1 text-xs text-[#6f6f6f]">{hint}</div> : null}
        </div>
    )
}

function StatBar({
    label,
    value
}: {
    label: string
    value: number
}) {
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm text-[#b0b0b0]">
                <span>{label}</span>
                <span className="font-medium text-white">{formatPercent(value)}</span>
            </div>
            <div className="h-2 rounded-full bg-[#1A1A1A] overflow-hidden">
                <div
                    className="h-full bg-[#86efac]"
                    style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
                />
            </div>
        </div>
    )
}

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const unwrappedParams = use(params)
    const userId = unwrappedParams.id

    const { data, error, isLoading, mutate } = useSWR<UserDetailResponse>(
        `/api/users/${userId}`,
        fetcher,
        { refreshInterval: 10000 }
    )
    const { toast } = useToast()

    const user = data
    const metrics = user?.metrics
    const equityCurve = user?.equityCurve ?? []
    const attemptStats = user?.attemptStats
    const pnl = (metrics?.execRealizedPnl ?? 0) + (metrics?.execUnrealizedPnl ?? 0)
    const pnlPositive = pnl >= 0

    const handleToggle = async () => {
        if (!user) return
        const nextEnabled = !user.enabled

        mutate(
            (current) => (current ? { ...current, enabled: nextEnabled } : current),
            false
        )

        try {
            const response = await fetch("/api/users/toggle", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: user.id, enabled: nextEnabled })
            })

            if (!response.ok) {
                throw new Error("Failed to update user status")
            }

            const updatedUser = await response.json()
            mutate(
                (current) =>
                    current ? { ...current, enabled: updatedUser.enabled } : current,
                false
            )
            mutate()
        } catch (toggleError) {
            mutate()
            toast({
                variant: "destructive",
                title: "Update failed",
                description: "Could not update user status."
            })
        }
    }

    return (
        <div className="relative w-full bg-black text-white overflow-hidden min-h-dvh md:h-screen">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-6 pt-20 md:pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                            <div>
                                <p className="text-sm text-[#6f6f6f]">Followed Users / Detail</p>
                                <h1 className="text-2xl md:text-3xl font-bold text-white">
                                    {user?.label ?? "User Detail"}
                                </h1>
                            </div>
                            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                                {user ? (
                                    <Link
                                        href={`https://polymarket.com/@${user.label}`}
                                        target="_blank"
                                        className="inline-flex items-center justify-center gap-2 rounded-full border border-[#27272A] bg-[#111111] px-4 py-2 text-sm text-[#cfcfcf] hover:text-white"
                                    >
                                        View on Polymarket
                                        <ExternalLink className="h-4 w-4" />
                                    </Link>
                                ) : null}
                                <Link
                                    href="/users"
                                    className="inline-flex items-center justify-center gap-2 rounded-full border border-[#27272A] bg-[#111111] px-4 py-2 text-sm text-[#cfcfcf] hover:bg-[#1A1A1A] hover:text-white"
                                >
                                    <ArrowLeft className="h-4 w-4" />
                                    Back to Users
                                </Link>
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="text-gray-400">Loading user detail...</div>
                        ) : error || !user ? (
                            <div className="text-red-500">Failed to load user detail</div>
                        ) : (
                            <div className="flex flex-col gap-6">
                                <div className="grid grid-cols-1 xl:grid-cols-[1.05fr_1.45fr] gap-6">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-4">
                                                <div className="h-12 w-12 rounded-full bg-[#1A1A1A] text-[#86efac] flex items-center justify-center font-bold">
                                                    {user.label.slice(0, 2).toUpperCase()}
                                                </div>
                                                <div>
                                                    <div className="text-xl font-semibold text-white">{user.label}</div>
                                                    <div className="text-sm text-[#6f6f6f] font-mono">
                                                        {formatWallet(user.profileWallet)}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <span
                                                    className={`px-3 py-1 rounded-full text-xs font-semibold ${
                                                        user.enabled
                                                            ? "bg-[#86efac] text-black"
                                                            : "bg-[#2a2a2a] text-[#9b9b9b]"
                                                    }`}
                                                >
                                                    {user.enabled ? "Active" : "Paused"}
                                                </span>
                                                <div className="flex items-center gap-2 text-xs text-[#6f6f6f]">
                                                    
                                                    <Switch
                                                        checked={user.enabled}
                                                        onCheckedChange={handleToggle}
                                                        className="data-[state=checked]:bg-[#86efac] data-[state=unchecked]:bg-[#27272A]"
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                                            <div className="text-[#6f6f6f]">
                                                Proxies
                                                <div className="text-white text-lg font-semibold">
                                                    {user.proxies.length}
                                                </div>
                                            </div>
                                            <div className="text-[#6f6f6f]">
                                                Copy Attempts
                                                <div className="text-white text-lg font-semibold">
                                                    {attemptStats?.totalAttempts ?? 0}
                                                </div>
                                            </div>
                                            <div className="text-[#6f6f6f]">
                                                Last Snapshot
                                                <div className="text-white text-sm">
                                                    {metrics?.lastSnapshotTs
                                                        ? formatDateTime(metrics.lastSnapshotTs)
                                                        : "No snapshots"}
                                                </div>
                                            </div>
                                            <div className="text-[#6f6f6f]">
                                                Exposure
                                                <div className="text-white text-lg font-semibold">
                                                    {formatCurrency(metrics?.execExposure ?? 0)}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                                        <MetricTile
                                            label="Shadow Equity"
                                            value={formatCurrency(metrics?.shadowEquity ?? 0)}
                                        />
                                        <MetricTile
                                            label="Exec Equity"
                                            value={formatCurrency(metrics?.execEquity ?? 0)}
                                        />
                                        <MetricTile
                                            label="Exec PnL"
                                            value={`${pnlPositive ? "+" : ""}${formatCurrency(pnl)}`}
                                            valueClassName={pnlPositive ? "text-[#86efac]" : "text-red-400"}
                                            hint={`${formatCurrency(metrics?.execRealizedPnl ?? 0)} realized`}
                                        />
                                        <MetricTile
                                            label="Fill Rate"
                                            value={formatPercent(attemptStats?.fillRate ?? 0)}
                                            hint={`${attemptStats?.executedAttempts ?? 0} executed`}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <TrendingUp className="h-4 w-4 text-[#86efac]" />
                                            Shadow vs Executable Equity
                                        </div>
                                        <div className="mt-4 h-[260px] sm:h-[320px]">
                                            {equityCurve.length > 0 ? (
                                                <ResponsiveContainer width="100%" height="100%">
                                                    <LineChart data={equityCurve}>
                                                        <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                        <XAxis
                                                            dataKey="ts"
                                                            tickFormatter={(value) => formatTime(value as number)}
                                                            tick={{ fill: "#6f6f6f" }}
                                                            axisLine={false}
                                                            tickLine={false}
                                                        />
                                                        <YAxis
                                                            tick={{ fill: "#6f6f6f" }}
                                                            axisLine={false}
                                                            tickLine={false}
                                                            tickFormatter={(value) => `$${value}`}
                                                        />
                                                        <Tooltip
                                                            content={({ active, payload, label }) => {
                                                                if (active && payload && payload.length) {
                                                                    return (
                                                                        <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                            <div className="text-[#6f6f6f]">
                                                                                {formatDateTime(label as number)}
                                                                            </div>
                                                                            <div className="mt-2 flex flex-col gap-1">
                                                                                <span>
                                                                                    Shadow:{" "}
                                                                                    {formatCurrency(
                                                                                        Number(payload[0].value)
                                                                                    )}
                                                                                </span>
                                                                                <span>
                                                                                    Exec:{" "}
                                                                                    {formatCurrency(
                                                                                        Number(payload[1].value)
                                                                                    )}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    )
                                                                }
                                                                return null
                                                            }}
                                                        />
                                                        <Line
                                                            type="monotone"
                                                            dataKey="shadow"
                                                            stroke="#9ca3af"
                                                            strokeWidth={2}
                                                            dot={false}
                                                        />
                                                        <Line
                                                            type="monotone"
                                                            dataKey="exec"
                                                            stroke="#86efac"
                                                            strokeWidth={2}
                                                            dot={false}
                                                        />
                                                    </LineChart>
                                                </ResponsiveContainer>
                                            ) : (
                                                <div className="h-full flex items-center justify-center text-[#6f6f6f]">
                                                    No equity snapshots yet
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-6">
                                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                            <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                                <TrendingDown className="h-4 w-4 text-blue-400" />
                                                Tracking Gap (Shadow - Exec)
                                            </div>
                                            <div className="mt-4 h-[180px]">
                                                {equityCurve.length > 0 ? (
                                                    <ResponsiveContainer width="100%" height="100%">
                                                        <AreaChart data={equityCurve}>
                                                            <defs>
                                                                <linearGradient id="gapFill" x1="0" y1="0" x2="0" y2="1">
                                                                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.4} />
                                                                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                                                                </linearGradient>
                                                            </defs>
                                                            <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                            <XAxis
                                                                dataKey="ts"
                                                                hide
                                                            />
                                                            <YAxis
                                                                tick={{ fill: "#6f6f6f" }}
                                                                axisLine={false}
                                                                tickLine={false}
                                                                tickFormatter={(value) => `$${value}`}
                                                            />
                                                            <Tooltip
                                                                content={({ active, payload, label }) => {
                                                                    if (active && payload && payload.length) {
                                                                        return (
                                                                            <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                                <div className="text-[#6f6f6f]">
                                                                                    {formatDateTime(label as number)}
                                                                                </div>
                                                                                <div className="mt-2">
                                                                                    Gap:{" "}
                                                                                    {formatCurrency(
                                                                                        Number(payload[0].value)
                                                                                    )}
                                                                                </div>
                                                                            </div>
                                                                        )
                                                                    }
                                                                    return null
                                                                }}
                                                            />
                                                            <Area
                                                                type="monotone"
                                                                dataKey="gap"
                                                                stroke="#38bdf8"
                                                                strokeWidth={2}
                                                                fill="url(#gapFill)"
                                                            />
                                                        </AreaChart>
                                                    </ResponsiveContainer>
                                                ) : (
                                                    <div className="h-full flex items-center justify-center text-[#6f6f6f]">
                                                        No tracking data yet
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                            <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                                <Activity className="h-4 w-4 text-[#86efac]" />
                                                Copy Rates
                                            </div>
                                            <div className="mt-4 flex flex-col gap-4">
                                                <StatBar label="Attempt Rate" value={attemptStats?.attemptRate ?? 0} />
                                                <StatBar label="Fill Rate" value={attemptStats?.fillRate ?? 0} />
                                                <StatBar label="Partial Fill Rate" value={attemptStats?.partialRate ?? 0} />
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {user.budgetedDynamic.enabled && user.budgetedDynamic.sizingMode === "budgetedDynamic" && (
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <TrendingUp className="h-4 w-4 text-[#86efac]" />
                                            Budgeted Dynamic Sizing
                                        </div>
                                        <div className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-4">
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">Budget</div>
                                                <div className="mt-1 text-xl font-semibold text-white">
                                                    {formatCurrency(user.budgetedDynamic.budgetUsd)}
                                                </div>
                                                <div className="mt-1 text-xs text-[#6f6f6f]">
                                                    Allocated for this leader
                                                </div>
                                            </div>
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">Leader Exposure</div>
                                                <div className="mt-1 text-xl font-semibold text-white">
                                                    {formatCurrency(user.budgetedDynamic.leaderExposureUsd)}
                                                </div>
                                                <div className="mt-1 text-xs text-[#6f6f6f]">
                                                    Their total exposure
                                                </div>
                                            </div>
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">Your Copy Exposure</div>
                                                <div className="mt-1 text-xl font-semibold text-white">
                                                    {formatCurrency(user.budgetedDynamic.currentCopyExposureUsd)}
                                                </div>
                                                <div className="mt-1 text-xs text-[#6f6f6f]">
                                                    Your exposure from this leader
                                                </div>
                                            </div>
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">Effective Rate</div>
                                                <div className="mt-1 text-xl font-semibold text-[#86efac]">
                                                    {user.budgetedDynamic.effectiveRatePct.toFixed(2)}%
                                                </div>
                                                <div className="mt-1 text-xs text-[#6f6f6f]">
                                                    r = budget / exposure (clamped {user.budgetedDynamic.rMinPct.toFixed(1)}-{user.budgetedDynamic.rMaxPct.toFixed(1)}%)
                                                </div>
                                            </div>
                                            <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                                <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">Headroom</div>
                                                <div className={`mt-1 text-xl font-semibold ${
                                                    user.budgetedDynamic.headroomUsd >= 0 ? "text-[#86efac]" : "text-red-400"
                                                }`}>
                                                    {formatCurrency(user.budgetedDynamic.headroomUsd)}
                                                </div>
                                                <div className="mt-1 text-xs text-[#6f6f6f]">
                                                    {user.budgetedDynamic.budgetEnforcement === "hard"
                                                        ? "Budget - exposure (HARD cap)"
                                                        : "Budget - exposure (SOFT)"
                                                    }
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <BarChart3 className="h-4 w-4 text-[#86efac]" />
                                            Slippage Distribution
                                        </div>
                                        <div className="mt-4 h-[220px]">
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={user.slippageHistogram}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                    <XAxis
                                                        dataKey="bucket"
                                                        tick={{ fill: "#6f6f6f", fontSize: 10 }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                    />
                                                    <YAxis
                                                        tick={{ fill: "#6f6f6f" }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                    />
                                                    <Tooltip
                                                        content={({ active, payload, label }) => {
                                                            if (active && payload && payload.length) {
                                                                return (
                                                                    <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                        <div>{label}</div>
                                                                        <div className="text-[#86efac]">
                                                                            {payload[0].value} fills
                                                                        </div>
                                                                    </div>
                                                                )
                                                            }
                                                            return null
                                                        }}
                                                    />
                                                    <Bar dataKey="count" fill="#86efac" radius={[6, 6, 0, 0]} />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <BarChart3 className="h-4 w-4 text-blue-400" />
                                            Detect Lag Distribution
                                        </div>
                                        <div className="mt-4 h-[220px]">
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={user.lagHistogram}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                    <XAxis
                                                        dataKey="bucket"
                                                        tick={{ fill: "#6f6f6f", fontSize: 10 }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                    />
                                                    <YAxis
                                                        tick={{ fill: "#6f6f6f" }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                    />
                                                    <Tooltip
                                                        content={({ active, payload, label }) => {
                                                            if (active && payload && payload.length) {
                                                                return (
                                                                    <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                        <div>{label}</div>
                                                                        <div className="text-blue-400">
                                                                            {payload[0].value} events
                                                                        </div>
                                                                    </div>
                                                                )
                                                            }
                                                            return null
                                                        }}
                                                    />
                                                    <Bar dataKey="count" fill="#60a5fa" radius={[6, 6, 0, 0]} />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <BarChart3 className="h-4 w-4 text-amber-400" />
                                            Skip Reasons
                                        </div>
                                        <div className="mt-4 h-[220px]">
                                            {user.skipReasons.length > 0 ? (
                                                <ResponsiveContainer width="100%" height="100%">
                                                    <BarChart data={user.skipReasons} layout="vertical">
                                                        <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                        <XAxis
                                                            type="number"
                                                            tick={{ fill: "#6f6f6f" }}
                                                            axisLine={false}
                                                            tickLine={false}
                                                        />
                                                        <YAxis
                                                            type="category"
                                                            dataKey="reason"
                                                            tick={{ fill: "#6f6f6f", fontSize: 10 }}
                                                            axisLine={false}
                                                            tickLine={false}
                                                            width={80}
                                                        />
                                                        <Tooltip
                                                            content={({ active, payload }) => {
                                                                if (active && payload && payload.length) {
                                                                    return (
                                                                        <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                            <div>{payload[0].payload.reason}</div>
                                                                            <div className="text-amber-400">
                                                                                {payload[0].value} skips
                                                                            </div>
                                                                        </div>
                                                                    )
                                                                }
                                                                return null
                                                            }}
                                                        />
                                                        <Bar dataKey="count" fill="#fbbf24" radius={[6, 6, 6, 6]} />
                                                    </BarChart>
                                                </ResponsiveContainer>
                                            ) : (
                                                <div className="h-full flex items-center justify-center text-[#6f6f6f]">
                                                    No skip data yet
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="text-sm text-[#6f6f6f]">Shadow Positions</div>
                                        <div className="mt-4 overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                        <th className="pb-3 text-left">Market</th>
                                                        <th className="pb-3 text-right">Shares</th>
                                                        <th className="pb-3 text-right">Invested</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {user.positions.shadow.length > 0 ? (
                                                        user.positions.shadow.map((pos) => (
                                                            <tr key={pos.assetId} className="border-b border-[#1A1A1A] last:border-0">
                                                                <td className="py-3 text-white">
                                                                    <div className="font-medium">{pos.marketTitle}</div>
                                                                    <div className="text-xs text-[#6f6f6f]">{pos.outcome}</div>
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {pos.shares.toFixed(2)}
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {formatCurrency(pos.invested)}
                                                                </td>
                                                            </tr>
                                                        ))
                                                    ) : (
                                                        <tr>
                                                            <td colSpan={3} className="py-6 text-center text-[#6f6f6f]">
                                                                No open positions
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="text-sm text-[#6f6f6f]">Executable Positions</div>
                                        <div className="mt-4 overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                        <th className="pb-3 text-left">Market</th>
                                                        <th className="pb-3 text-right">Shares</th>
                                                        <th className="pb-3 text-right">Invested</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {user.positions.exec.length > 0 ? (
                                                        user.positions.exec.map((pos) => (
                                                            <tr key={pos.assetId} className="border-b border-[#1A1A1A] last:border-0">
                                                                <td className="py-3 text-white">
                                                                    <div className="font-medium">{pos.marketTitle}</div>
                                                                    <div className="text-xs text-[#6f6f6f]">{pos.outcome}</div>
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {pos.shares.toFixed(2)}
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {formatCurrency(pos.invested)}
                                                                </td>
                                                            </tr>
                                                        ))
                                                    ) : (
                                                        <tr>
                                                            <td colSpan={3} className="py-6 text-center text-[#6f6f6f]">
                                                                No open positions
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="text-sm text-[#6f6f6f]">Recent Trades</div>
                                        <div className="mt-4 overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                        <th className="pb-3 text-left">Time</th>
                                                        <th className="pb-3 text-left">Side</th>
                                                        <th className="pb-3 text-right">Price</th>
                                                        <th className="pb-3 text-right">Shares</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {user.recentTrades.length > 0 ? (
                                                        user.recentTrades.map((trade) => (
                                                            <tr key={trade.id} className="border-b border-[#1A1A1A] last:border-0">
                                                                <td className="py-3 text-[#6f6f6f]">
                                                                    {formatDateTime(trade.eventTime)}
                                                                </td>
                                                                <td className="py-3 text-white">
                                                                    <span
                                                                        className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                                                            trade.side === "BUY"
                                                                                ? "bg-[#102b1a] text-[#86efac]"
                                                                                : "bg-[#2b1212] text-[#f87171]"
                                                                        }`}
                                                                    >
                                                                        {trade.side}
                                                                    </span>
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {trade.price.toFixed(3)}
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {trade.shares.toFixed(2)}
                                                                </td>
                                                            </tr>
                                                        ))
                                                    ) : (
                                                        <tr>
                                                            <td colSpan={4} className="py-6 text-center text-[#6f6f6f]">
                                                                No trades yet
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="text-sm text-[#6f6f6f]">Copy Attempts</div>
                                        <div className="mt-4 overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                        <th className="pb-3 text-left">Time</th>
                                                        <th className="pb-3 text-left">Decision</th>
                                                        <th className="pb-3 text-right">Target</th>
                                                        <th className="pb-3 text-right">Filled</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {user.recentAttempts.length > 0 ? (
                                                        user.recentAttempts.map((attempt) => {
                                                            const fillRatio = attempt.filledRatioBps / 100
                                                            return (
                                                                <tr key={attempt.id} className="border-b border-[#1A1A1A] last:border-0">
                                                                    <td className="py-3 text-[#6f6f6f]">
                                                                        {formatDateTime(attempt.createdAt)}
                                                                    </td>
                                                                    <td className="py-3 text-white">
                                                                        <span
                                                                            className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                                                                attempt.decision === "EXECUTE"
                                                                                    ? "bg-[#102b1a] text-[#86efac]"
                                                                                    : "bg-[#2b1212] text-[#f87171]"
                                                                            }`}
                                                                        >
                                                                            {attempt.decision}
                                                                        </span>
                                                                    </td>
                                                                    <td className="py-3 text-right text-white">
                                                                        {formatCurrency(attempt.targetNotional)}
                                                                    </td>
                                                                    <td className="py-3 text-right text-white">
                                                                        {formatCurrency(attempt.filledNotional)}{" "}
                                                                        <span className="text-xs text-[#6f6f6f]">
                                                                            ({fillRatio.toFixed(1)}%)
                                                                        </span>
                                                                    </td>
                                                                </tr>
                                                            )
                                                        })
                                                    ) : (
                                                        <tr>
                                                            <td colSpan={4} className="py-6 text-center text-[#6f6f6f]">
                                                                No copy attempts yet
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
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
