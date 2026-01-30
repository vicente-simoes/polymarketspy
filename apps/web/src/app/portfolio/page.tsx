"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from "recharts"
import { Activity, Shield, TrendingDown, TrendingUp } from "lucide-react"

interface GlobalPortfolioResponse {
    positions: {
        assetId: string | null
        marketId: string | null
        shares: number
        invested: number
        markPrice: number | null
        marketValue: number | null
        marketTitle: string
        outcome: string
    }[]
    exposureByMarket: {
        marketId: string
        marketTitle: string
        exposure: number
        pct: number
    }[]
    exposureByUser: {
        userId: string
        label: string
        exposure: number
        pct: number
    }[]
    metrics: {
        equity: number
        cash: number
        exposure: number
        pnl: number
        pnl1h: number | null
        pnl24h: number | null
        pnl7d: number | null
        pnl30d: number | null
        exposurePct: number
        maxTotalExposurePct: number
        riskUtilizationPct: number
        maxDrawdownPct: number
        currentDrawdownPct: number
        maxDrawdownLimitPct: number
        drawdownUtilizationPct: number
    }
}

interface GlobalPnlCurveResponse {
    range: string
    pnlCurve: {
        date: string
        timestamp: number
        value: number
    }[]
}

const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2
    }).format(value)

const formatSignedCurrency = (value: number) => `${value >= 0 ? "+" : ""}${formatCurrency(value)}`

const formatPercent = (value: number) => `${value.toFixed(1)}%`

const trimLabel = (value: string, limit = 18) =>
    value.length > limit ? `${value.slice(0, limit)}...` : value

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

function ProgressStat({
    label,
    value,
    status,
    hint
}: {
    label: string
    value: number
    status: "good" | "warn" | "bad"
    hint?: string
}) {
    const barColor =
        status === "good" ? "bg-[#86efac]" : status === "warn" ? "bg-amber-400" : "bg-red-500"
    const textColor =
        status === "good" ? "text-[#86efac]" : status === "warn" ? "text-amber-400" : "text-red-400"

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm text-[#b0b0b0]">
                <span>{label}</span>
                <span className={`font-medium ${textColor}`}>{formatPercent(value)}</span>
            </div>
            <div className="h-2 rounded-full bg-[#1A1A1A] overflow-hidden">
                <div
                    className={`h-full ${barColor}`}
                    style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
                />
            </div>
            {hint ? <div className="text-xs text-[#6f6f6f]">{hint}</div> : null}
        </div>
    )
}

export default function PortfolioPage() {
    const router = useRouter()
    const [pnlRange, setPnlRange] = useState<"1H" | "1D" | "1W" | "1M">("1D")
    const { data, error, isLoading } = useSWR<GlobalPortfolioResponse>(
        "/api/portfolio/global",
        fetcher,
        { refreshInterval: 10000 }
    )
    const {
        data: pnlCurveData,
        error: pnlCurveError,
        isLoading: pnlCurveLoading
    } = useSWR<GlobalPnlCurveResponse>(
        `/api/portfolio/global/pnl?range=${pnlRange}`,
        fetcher,
        { refreshInterval: 10000 }
    )

    const metrics = data?.metrics
    const pnl = metrics?.pnl ?? 0
    const pnlPositive = pnl >= 0
    const pnl1h = metrics?.pnl1h ?? null
    const pnl24h = metrics?.pnl24h ?? null
    const pnl7d = metrics?.pnl7d ?? null
    const pnl30d = metrics?.pnl30d ?? null
    const riskUtilization = metrics?.riskUtilizationPct ?? 0
    const drawdownUtilization = metrics?.drawdownUtilizationPct ?? 0
    const pnlCurve = pnlCurveData?.pnlCurve ?? []
    const pnlCurveHasData = pnlCurve.length > 0
    const pnlCurveLastValue = pnlCurveHasData ? pnlCurve[pnlCurve.length - 1].value : 0
    const pnlCurvePositive = pnlCurveLastValue >= 0
    const pnlCurveColor = pnlCurvePositive ? "#86efac" : "#f87171"

    const pnlCurveDomain = useMemo(() => {
        if (!pnlCurveHasData) return { min: -1, max: 1 }
        const values = pnlCurve.map((p) => p.value)
        let min = Math.min(...values)
        let max = Math.max(...values)
        if (min === max) {
            min -= 1
            max += 1
        }
        const padding = (max - min) * 0.08
        return { min: min - padding, max: max + padding }
    }, [pnlCurve, pnlCurveHasData])

    const formatPnlXAxis = (tickItem: string) => {
        const date = new Date(tickItem)
        if (pnlRange === "1H" || pnlRange === "1D") {
            return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        }
        return date.toLocaleDateString([], { month: "short", day: "numeric" })
    }

    const riskStatus =
        riskUtilization > 90 ? "bad" : riskUtilization > 70 ? "warn" : "good"
    const drawdownStatus =
        drawdownUtilization > 90 ? "bad" : drawdownUtilization > 70 ? "warn" : "good"

    const sortedPositions = data?.positions
        ? [...data.positions].sort((a, b) => {
              const aValue = a.marketValue ?? a.invested
              const bValue = b.marketValue ?? b.invested
              const diff = Math.abs(bValue) - Math.abs(aValue)
              if (diff !== 0) return diff
              return a.marketTitle.localeCompare(b.marketTitle)
          })
        : []

    return (
        <div className="relative w-full bg-black text-white overflow-hidden min-h-dvh md:h-screen">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-6 pt-20 md:pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <p className="text-sm text-[#6f6f6f]">Global Portfolio</p>
                                <h1 className="text-2xl md:text-3xl font-bold text-white">Executable Portfolio</h1>
                            </div>
                            <div className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#111111] px-4 py-2 text-sm text-[#cfcfcf]">
                                <Activity className="h-4 w-4 text-[#86efac]" />
                                EXEC_GLOBAL
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="text-gray-400">Loading portfolio...</div>
                        ) : error || !data || !metrics ? (
                            <div className="text-red-500">Failed to load portfolio</div>
                        ) : (
	                            <div className="flex flex-col gap-6">
	                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
	                                    <MetricTile
	                                        label="Total Equity"
	                                        value={formatCurrency(metrics.equity)}
                                    />
                                    <MetricTile
                                        label="Exposure"
                                        value={formatCurrency(metrics.exposure)}
                                        hint={`${formatPercent(metrics.exposurePct)} of equity`}
                                    />
                                    <MetricTile label="Cash" value={formatCurrency(metrics.cash)} />
                                    <MetricTile
                                        label="Total PnL"
                                        value={formatSignedCurrency(pnl)}
                                        valueClassName={pnlPositive ? "text-[#86efac]" : "text-red-400"}
                                    />
                                    <MetricTile
                                        label="PnL (1H)"
                                        value={pnl1h === null ? "--" : formatSignedCurrency(pnl1h)}
                                        valueClassName={
                                            pnl1h === null
                                                ? "text-[#6f6f6f]"
                                                : pnl1h >= 0
                                                    ? "text-[#86efac]"
                                                    : "text-red-400"
                                        }
                                    />
                                    <MetricTile
                                        label="PnL (24H)"
                                        value={pnl24h === null ? "--" : formatSignedCurrency(pnl24h)}
                                        valueClassName={
                                            pnl24h === null
                                                ? "text-[#6f6f6f]"
                                                : pnl24h >= 0
                                                    ? "text-[#86efac]"
                                                    : "text-red-400"
                                        }
                                    />
                                    <MetricTile
                                        label="PnL (1W)"
                                        value={pnl7d === null ? "--" : formatSignedCurrency(pnl7d)}
                                        valueClassName={
                                            pnl7d === null
                                                ? "text-[#6f6f6f]"
                                                : pnl7d >= 0
                                                    ? "text-[#86efac]"
                                                    : "text-red-400"
                                        }
                                    />
                                    <MetricTile
                                        label="PnL (1M)"
                                        value={pnl30d === null ? "--" : formatSignedCurrency(pnl30d)}
                                        valueClassName={
                                            pnl30d === null
                                                ? "text-[#6f6f6f]"
                                                : pnl30d >= 0
                                                    ? "text-[#86efac]"
                                                    : "text-red-400"
                                        }
                                    />
                                    <MetricTile
                                        label="Max Drawdown"
                                        value={`-${metrics.maxDrawdownPct.toFixed(2)}%`}
                                        valueClassName="text-red-400"
                                        hint={`Current ${metrics.currentDrawdownPct.toFixed(2)}%`}
                                    />
                                    <MetricTile
                                        label="Risk Utilization"
                                        value={formatPercent(riskUtilization)}
                                        valueClassName={
                                            riskStatus === "good"
                                                ? "text-[#86efac]"
                                                : riskStatus === "warn"
                                                    ? "text-amber-400"
                                                    : "text-red-400"
                                        }
	                                        hint={`Cap ${metrics.maxTotalExposurePct.toFixed(0)}%`}
	                                    />
	                                </div>

	                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
	                                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
	                                        <div className="flex items-center gap-3">
	                                            <h2 className="text-xl font-medium text-white">PnL</h2>
	                                            <div className="text-sm text-[#6f6f6f]">
	                                                Δ {pnlCurveHasData ? formatSignedCurrency(pnlCurveLastValue) : "--"}
	                                            </div>
	                                        </div>

	                                        <div className="flex items-center bg-[#1A1A1A] rounded-lg p-1 max-w-full overflow-x-auto no-scrollbar">
	                                            {[
	                                                { label: "1H", value: "1H" as const },
	                                                { label: "24H", value: "1D" as const },
	                                                { label: "1W", value: "1W" as const },
	                                                { label: "1M", value: "1M" as const }
	                                            ].map((option) => (
	                                                <button
	                                                    key={option.value}
	                                                    onClick={() => setPnlRange(option.value)}
	                                                    className={`px-3 py-1 text-sm rounded-md transition-colors shrink-0 ${
	                                                        pnlRange === option.value
	                                                            ? "bg-[#2A2A2A] text-white shadow-sm"
	                                                            : "text-gray-400 hover:text-white"
	                                                    }`}
	                                                >
	                                                    {option.label}
	                                                </button>
	                                            ))}
	                                        </div>
	                                    </div>

	                                    <div className="mt-4 h-[260px]">
	                                        {pnlCurveLoading && !pnlCurveHasData ? (
	                                            <div className="h-full flex items-center justify-center text-[#6f6f6f]">
	                                                Loading PnL chart...
	                                            </div>
	                                        ) : pnlCurveError ? (
	                                            <div className="h-full flex items-center justify-center text-red-500">
	                                                Failed to load PnL chart
	                                            </div>
	                                        ) : pnlCurveHasData ? (
	                                            <ResponsiveContainer width="100%" height="100%">
	                                                <AreaChart data={pnlCurve}>
	                                                    <defs>
	                                                        <linearGradient
	                                                            id="pnlGradient"
	                                                            x1="0"
	                                                            y1="0"
	                                                            x2="0"
	                                                            y2="1"
	                                                        >
	                                                            <stop
	                                                                offset="5%"
	                                                                stopColor={pnlCurveColor}
	                                                                stopOpacity={0.3}
	                                                            />
	                                                            <stop
	                                                                offset="95%"
	                                                                stopColor={pnlCurveColor}
	                                                                stopOpacity={0}
	                                                            />
	                                                        </linearGradient>
	                                                    </defs>
	                                                    <CartesianGrid
	                                                        strokeDasharray="3 3"
	                                                        stroke="#1F1F1F"
	                                                        vertical={false}
	                                                    />
	                                                    <XAxis
	                                                        dataKey="date"
	                                                        tick={{ fill: "#6f6f6f", fontSize: 10 }}
	                                                        axisLine={false}
	                                                        tickLine={false}
	                                                        minTickGap={24}
	                                                        tickFormatter={formatPnlXAxis}
	                                                    />
	                                                    <YAxis
	                                                        domain={[pnlCurveDomain.min, pnlCurveDomain.max]}
	                                                        tick={{ fill: "#6f6f6f" }}
	                                                        axisLine={false}
	                                                        tickLine={false}
	                                                        tickFormatter={(value) =>
	                                                            `${value >= 0 ? "+" : ""}${formatCurrency(value)}`
	                                                        }
	                                                    />
	                                                    <ReferenceLine y={0} stroke="#27272A" strokeDasharray="4 4" />
	                                                    <Tooltip
	                                                        content={({ active, payload }) => {
	                                                            if (active && payload && payload.length) {
	                                                                const point = payload[0].payload as {
	                                                                    date: string
	                                                                    value: number
	                                                                }
	                                                                const date = new Date(point.date)
	                                                                const formattedDate =
	                                                                    pnlRange === "1H" || pnlRange === "1D"
	                                                                        ? date.toLocaleString([], {
	                                                                              month: "short",
	                                                                              day: "numeric",
	                                                                              hour: "2-digit",
	                                                                              minute: "2-digit"
	                                                                          })
	                                                                        : date.toLocaleDateString([], {
	                                                                              year: "numeric",
	                                                                              month: "short",
	                                                                              day: "numeric"
	                                                                          })
	                                                                return (
	                                                                    <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
	                                                                        <div className="text-[#6f6f6f]">
	                                                                            {formattedDate}
	                                                                        </div>
	                                                                        <div
	                                                                            className={`mt-1 ${
	                                                                                point.value >= 0
	                                                                                    ? "text-[#86efac]"
	                                                                                    : "text-red-400"
	                                                                            }`}
	                                                                        >
	                                                                            {formatSignedCurrency(point.value)}
	                                                                        </div>
	                                                                    </div>
	                                                                )
	                                                            }
	                                                            return null
	                                                        }}
	                                                    />
	                                                    <Area
	                                                        type="monotone"
	                                                        dataKey="value"
	                                                        stroke={pnlCurveColor}
	                                                        strokeWidth={2}
	                                                        fillOpacity={1}
	                                                        fill="url(#pnlGradient)"
	                                                    />
	                                                </AreaChart>
	                                            </ResponsiveContainer>
	                                        ) : (
	                                            <div className="h-full flex items-center justify-center text-[#6f6f6f]">
	                                                No PnL history yet
	                                            </div>
	                                        )}
	                                    </div>
	                                </div>

	                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
	                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
	                                        <div className="text-sm text-[#6f6f6f]">Exposure by User</div>
	                                        <div className="mt-4 h-[260px]">
                                            {data.exposureByUser.length > 0 ? (
                                                <ResponsiveContainer width="100%" height="100%">
                                                    <BarChart data={data.exposureByUser}>
                                                        <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                        <XAxis
                                                            dataKey="label"
                                                            tick={{ fill: "#6f6f6f", fontSize: 10 }}
                                                            axisLine={false}
                                                            tickLine={false}
                                                            tickFormatter={(value) =>
                                                                trimLabel(String(value), 10)
                                                            }
                                                        />
                                                        <YAxis
                                                            tick={{ fill: "#6f6f6f" }}
                                                            axisLine={false}
                                                            tickLine={false}
                                                            tickFormatter={(value) => `$${value}`}
                                                        />
                                                        <Tooltip
                                                            content={({ active, payload }) => {
                                                                if (active && payload && payload.length) {
                                                                    return (
                                                                        <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                            <div className="text-[#6f6f6f]">
                                                                                {payload[0].payload.label}
                                                                            </div>
                                                                            <div className="mt-1 text-[#86efac]">
                                                                                {formatCurrency(payload[0].value as number)}
                                                                            </div>
                                                                        </div>
                                                                    )
                                                                }
                                                                return null
                                                            }}
                                                        />
                                                        <Bar dataKey="exposure" fill="#60a5fa" radius={[6, 6, 0, 0]} />
                                                    </BarChart>
                                                </ResponsiveContainer>
                                            ) : (
                                                <div className="h-full flex items-center justify-center text-[#6f6f6f]">
                                                    No user exposure yet
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                        <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                            <Shield className="h-4 w-4 text-[#86efac]" />
                                            Risk Utilization
                                        </div>
                                        <div className="mt-4 flex flex-col gap-4">
                                            <ProgressStat
                                                label="Exposure vs Cap"
                                                value={riskUtilization}
                                                status={riskStatus}
                                                hint={`Limit ${metrics.maxTotalExposurePct.toFixed(0)}%`}
                                            />
                                            <ProgressStat
                                                label="Drawdown vs Limit"
                                                value={drawdownUtilization}
                                                status={drawdownStatus}
                                                hint={`Limit ${metrics.maxDrawdownLimitPct.toFixed(1)}%`}
                                            />
                                        </div>
                                        <div className="mt-6 flex items-center gap-3 text-sm text-[#6f6f6f]">
                                            <TrendingUp className="h-4 w-4 text-[#86efac]" />
                                            Exposure {formatPercent(metrics.exposurePct)} of equity
                                        </div>
                                        <div className="mt-2 flex items-center gap-3 text-sm text-[#6f6f6f]">
                                            <TrendingDown className="h-4 w-4 text-red-400" />
                                            Current drawdown {metrics.currentDrawdownPct.toFixed(2)}%
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                    <div className="text-sm text-[#6f6f6f]">Exposure by Market</div>
                                    <div className="mt-4 h-[260px]">
                                        {data.exposureByMarket.length > 0 ? (
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={data.exposureByMarket}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                    <XAxis
                                                        dataKey="marketTitle"
                                                        tick={{ fill: "#6f6f6f", fontSize: 10 }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                        tickFormatter={(value) =>
                                                            trimLabel(String(value), 12)
                                                        }
                                                    />
                                                    <YAxis
                                                        tick={{ fill: "#6f6f6f" }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                        tickFormatter={(value) => `$${value}`}
                                                    />
                                                    <Tooltip
                                                        content={({ active, payload }) => {
                                                            if (active && payload && payload.length) {
                                                                return (
                                                                    <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                        <div className="text-[#6f6f6f]">
                                                                            {payload[0].payload.marketTitle}
                                                                        </div>
                                                                        <div className="mt-1 text-[#86efac]">
                                                                            {formatCurrency(payload[0].value as number)}
                                                                        </div>
                                                                    </div>
                                                                )
                                                            }
                                                            return null
                                                        }}
                                                    />
                                                    <Bar dataKey="exposure" fill="#86efac" radius={[6, 6, 0, 0]} />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        ) : (
                                            <div className="h-full flex items-center justify-center text-[#6f6f6f]">
                                                No exposure yet
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                                    <div className="text-sm text-[#6f6f6f]">Open Positions</div>
                                    <div className="mt-4 md:hidden flex flex-col gap-3">
                                        {sortedPositions.length > 0 ? (
                                            sortedPositions.map((position) => {
                                                const marketValue = position.marketValue ?? position.invested
                                                const clickable = Boolean(position.assetId)
                                                return (
                                                    <div
                                                        key={`${position.assetId ?? "unknown"}-${position.marketId ?? "market"}`}
                                                        className={`rounded-2xl border border-[#27272A] bg-[#111111] p-4 ${clickable ? "cursor-pointer hover:bg-[#1A1A1A]" : ""}`}
                                                        onClick={() => {
                                                            if (position.assetId) {
                                                                router.push(`/portfolio/positions/${encodeURIComponent(position.assetId)}`)
                                                            }
                                                        }}
                                                        onKeyDown={(event) => {
                                                            if (!position.assetId) return
                                                            if (event.key === "Enter" || event.key === " ") {
                                                                event.preventDefault()
                                                                router.push(`/portfolio/positions/${encodeURIComponent(position.assetId)}`)
                                                            }
                                                        }}
                                                        role={position.assetId ? "link" : undefined}
                                                        tabIndex={position.assetId ? 0 : undefined}
                                                    >
                                                        <div className="text-sm font-medium text-white">
                                                            {position.marketTitle}
                                                        </div>
                                                        <div className="mt-0.5 text-xs text-[#6f6f6f]">
                                                            {position.outcome}
                                                        </div>

                                                        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                                                            <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                    Value
                                                                </div>
                                                                <div className="mt-1 text-white font-mono">
                                                                    {formatCurrency(marketValue)}
                                                                </div>
                                                            </div>
                                                            <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                    Invested
                                                                </div>
                                                                <div className="mt-1 text-white font-mono">
                                                                    {formatCurrency(position.invested)}
                                                                </div>
                                                            </div>
                                                            <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                    Shares
                                                                </div>
                                                                <div className="mt-1 text-white font-mono">
                                                                    {position.shares.toFixed(2)}
                                                                </div>
                                                            </div>
                                                            <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                    Mark
                                                                </div>
                                                                <div className="mt-1 text-white font-mono">
                                                                    {position.markPrice !== null
                                                                        ? position.markPrice.toFixed(3)
                                                                        : "--"}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            })
                                        ) : (
                                            <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-6 text-center text-[#6f6f6f]">
                                                No open positions
                                            </div>
                                        )}
                                    </div>

                                    <div className="mt-4 hidden md:block overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                    <th className="pb-3 text-left">Market</th>
                                                    <th className="pb-3 text-right">Shares</th>
                                                    <th className="pb-3 text-right">Mark</th>
                                                    <th className="pb-3 text-right">Value</th>
                                                    <th className="pb-3 text-right">Invested</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sortedPositions.length > 0 ? (
                                                    sortedPositions.map((position) => {
                                                        const marketValue =
                                                            position.marketValue ?? position.invested
                                                        return (
                                                            <tr
                                                                key={`${position.assetId ?? "unknown"}-${position.marketId ?? "market"}`}
                                                                className={`border-b border-[#1A1A1A] last:border-0 ${position.assetId ? "cursor-pointer hover:bg-[#111111]" : ""}`}
                                                                onClick={() => {
                                                                    if (position.assetId) {
                                                                        router.push(`/portfolio/positions/${encodeURIComponent(position.assetId)}`)
                                                                    }
                                                                }}
                                                                onKeyDown={(event) => {
                                                                    if (!position.assetId) return
                                                                    if (event.key === "Enter" || event.key === " ") {
                                                                        event.preventDefault()
                                                                        router.push(`/portfolio/positions/${encodeURIComponent(position.assetId)}`)
                                                                    }
                                                                }}
                                                                role={position.assetId ? "link" : undefined}
                                                                tabIndex={position.assetId ? 0 : undefined}
                                                            >
                                                                <td className="py-3 text-white">
                                                                    <div className="font-medium">
                                                                        {position.marketTitle}
                                                                    </div>
                                                                    <div className="text-xs text-[#6f6f6f]">
                                                                        {position.outcome}
                                                                    </div>
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {position.shares.toFixed(2)}
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {position.markPrice !== null
                                                                        ? position.markPrice.toFixed(3)
                                                                        : "--"}
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {formatCurrency(marketValue)}
                                                                </td>
                                                                <td className="py-3 text-right text-white">
                                                                    {formatCurrency(position.invested)}
                                                                </td>
                                                            </tr>
                                                        )
                                                    })
                                                ) : (
                                                    <tr>
                                                        <td
                                                            colSpan={5}
                                                            className="py-6 text-center text-[#6f6f6f]"
                                                        >
                                                            No open positions
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
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
