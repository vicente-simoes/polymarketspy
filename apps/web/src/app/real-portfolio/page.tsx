"use client"

import { Header } from "@/components/header"
import { Sidebar } from "@/components/sidebar"
import { fetcher } from "@/lib/fetcher"
import useSWR from "swr"
import { useMemo, useState } from "react"
import {
    Area,
    AreaChart,
    CartesianGrid,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts"
import { Activity, Database, TriangleAlert } from "lucide-react"

type RealPortfolioResponse = {
    baseline: {
        time: string | null
        equity: number
    }
    lastReconciledAt: string | null
    ledgerVsExchangeDiff: {
        asOf: string | null
        cashDiffMicros: string
        positionDiffCount: number
        maxAbsPositionDiffMicros: string
    } | null
    positions: Array<{
        assetId: string
        marketId: string | null
        shares: number
        markPrice: number | null
        marketValue: number | null
        marketTitle: string
        outcome: string
    }>
    metrics: {
        equity: number
        cash: number
        exposure: number
        pnlSinceBaseline: number
    }
}

type PnlCurveResponse = {
    range: string
    pnlCurve: Array<{ date: string; timestamp: number; value: number }>
}

const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
    }).format(value)

const formatSignedCurrency = (value: number) => `${value >= 0 ? "+" : ""}${formatCurrency(value)}`

function MetricTile({
    label,
    value,
    hint,
    valueClassName,
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

function StatusPill({ value }: { value: "ok" | "warn" | "bad" }) {
    const tone =
        value === "ok"
            ? "bg-[#102b1a] text-[#86efac]"
            : value === "warn"
              ? "bg-[#2b2312] text-amber-400"
              : "bg-[#2b1212] text-[#f87171]"
    return <span className={`rounded-full px-2 py-1 text-xs font-semibold ${tone}`}>{value}</span>
}

const formatTime = (value: string | null) => (value ? new Date(value).toLocaleString() : "--")

export default function RealPortfolioPage() {
    const [pnlRange, setPnlRange] = useState<"1H" | "1D" | "1W" | "1M">("1D")

    const { data, error, isLoading } = useSWR<RealPortfolioResponse>(
        "/api/portfolio/live/global",
        fetcher,
        { refreshInterval: 30000 }
    )
    const { data: pnlData } = useSWR<PnlCurveResponse>(
        `/api/portfolio/live/global/pnl?range=${pnlRange}`,
        fetcher,
        { refreshInterval: 30000 }
    )

    const diffStatus = useMemo(() => {
        const diff = data?.ledgerVsExchangeDiff
        if (!diff) return { pill: "warn" as const, label: "unknown" }
        let cashDiff = BigInt(0)
        try {
            cashDiff = BigInt(diff.cashDiffMicros)
        } catch {
            cashDiff = BigInt(0)
        }
        const hasDiffs = cashDiff !== BigInt(0) || diff.positionDiffCount > 0
        return hasDiffs
            ? { pill: "bad" as const, label: "diffs detected" }
            : { pill: "ok" as const, label: "no diffs" }
    }, [data?.ledgerVsExchangeDiff])

    const pnlCurve = pnlData?.pnlCurve ?? []
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

    const sortedPositions = data?.positions
        ? [...data.positions].sort((a, b) => {
              const aValue = Math.abs(a.marketValue ?? 0)
              const bValue = Math.abs(b.marketValue ?? 0)
              if (bValue !== aValue) return bValue - aValue
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
                                <p className="text-sm text-[#6f6f6f]">Real Portfolio</p>
                                <h1 className="text-2xl md:text-3xl font-bold text-white">
                                    Exchange-Authoritative (LIVE)
                                </h1>
                            </div>
                            <div className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#111111] px-4 py-2 text-sm text-[#cfcfcf]">
                                <Activity className="h-4 w-4 text-[#86efac]" />
                                LIVE
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="text-gray-400">Loading real portfolio...</div>
                        ) : error || !data ? (
                            <div className="text-red-500">Failed to load real portfolio</div>
                        ) : (
                            <div className="flex flex-col gap-6">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Baseline
                                            </div>
                                            <StatusPill value={data.baseline.time ? "ok" : "warn"} />
                                        </div>
                                        <div className="mt-2 text-sm text-white">
                                            PnL since{" "}
                                            {data.baseline.time ? formatTime(data.baseline.time) : "--"}
                                        </div>
                                        <div className="mt-1 text-xs text-[#6f6f6f]">
                                            Baseline equity: {formatCurrency(data.baseline.equity)}
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Last Reconciliation
                                            </div>
                                            <StatusPill value={data.lastReconciledAt ? "ok" : "warn"} />
                                        </div>
                                        <div className="mt-2 text-sm text-white">
                                            {formatTime(data.lastReconciledAt)}
                                        </div>
                                        <div className="mt-1 text-xs text-[#6f6f6f]">
                                            From periodic exchange state snapshots
                                        </div>
                                    </div>

                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Ledger vs Exchange
                                            </div>
                                            <StatusPill value={diffStatus.pill} />
                                        </div>
                                        <div className="mt-2 text-sm text-white">{diffStatus.label}</div>
                                        <div className="mt-1 text-xs text-[#6f6f6f]">
                                            as of {formatTime(data.ledgerVsExchangeDiff?.asOf ?? null)}
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                    <MetricTile label="Total Equity" value={formatCurrency(data.metrics.equity)} />
                                    <MetricTile label="Cash" value={formatCurrency(data.metrics.cash)} />
                                    <MetricTile label="Exposure" value={formatCurrency(data.metrics.exposure)} />
                                    <MetricTile
                                        label="PnL Since Baseline"
                                        value={formatSignedCurrency(data.metrics.pnlSinceBaseline)}
                                        valueClassName={
                                            data.metrics.pnlSinceBaseline >= 0
                                                ? "text-[#86efac]"
                                                : "text-[#f87171]"
                                        }
                                    />
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div>
                                            <div className="text-sm text-[#6f6f6f]">PnL Since Baseline</div>
                                            <div className="mt-1 text-xs text-[#6f6f6f]">
                                                Equity points computed from LIVE positions + midpoint marks.
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#111111] p-1">
                                            {(["1H", "1D", "1W", "1M"] as const).map((range) => (
                                                <button
                                                    key={range}
                                                    className={`px-3 py-1 text-xs rounded-full ${
                                                        pnlRange === range
                                                            ? "bg-[#1f1f1f] text-white"
                                                            : "text-[#b0b0b0] hover:text-white"
                                                    }`}
                                                    onClick={() => setPnlRange(range)}
                                                >
                                                    {range}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="mt-4 h-64">
                                        {pnlCurveHasData ? (
                                            <ResponsiveContainer width="100%" height="100%">
                                                <AreaChart data={pnlCurve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                                    <defs>
                                                        <linearGradient id="pnlGradientLive" x1="0" y1="0" x2="0" y2="1">
                                                            <stop offset="5%" stopColor={pnlCurveColor} stopOpacity={0.35} />
                                                            <stop offset="95%" stopColor={pnlCurveColor} stopOpacity={0.02} />
                                                        </linearGradient>
                                                    </defs>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#1A1A1A" />
                                                    <XAxis
                                                        dataKey="date"
                                                        stroke="#6f6f6f"
                                                        axisLine={false}
                                                        tickLine={false}
                                                        tickFormatter={(value) => {
                                                            const date = new Date(value)
                                                            if (pnlRange === "1H" || pnlRange === "1D") {
                                                                return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                                                            }
                                                            return date.toLocaleDateString([], { month: "short", day: "numeric" })
                                                        }}
                                                    />
                                                    <YAxis
                                                        stroke="#6f6f6f"
                                                        axisLine={false}
                                                        tickLine={false}
                                                        domain={[pnlCurveDomain.min, pnlCurveDomain.max]}
                                                        tickFormatter={(value) => `$${value}`}
                                                    />
                                                    <Tooltip
                                                        content={({ active, payload }) => {
                                                            if (active && payload && payload.length) {
                                                                const p = payload[0].payload as any
                                                                return (
                                                                    <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                        <div className="text-[#6f6f6f]">
                                                                            {new Date(p.date).toLocaleString()}
                                                                        </div>
                                                                        <div className="mt-1" style={{ color: pnlCurveColor }}>
                                                                            {formatSignedCurrency(p.value)}
                                                                        </div>
                                                                    </div>
                                                                )
                                                            }
                                                            return null
                                                        }}
                                                    />
                                                    <ReferenceLine y={0} stroke="#27272A" />
                                                    <Area
                                                        type="monotone"
                                                        dataKey="value"
                                                        stroke={pnlCurveColor}
                                                        fillOpacity={1}
                                                        fill="url(#pnlGradientLive)"
                                                        strokeWidth={2}
                                                    />
                                                </AreaChart>
                                            </ResponsiveContainer>
                                        ) : (
                                            <div className="h-full flex flex-col items-center justify-center text-[#6f6f6f] gap-2">
                                                <Database className="h-5 w-5" />
                                                <div>No LIVE equity points yet</div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <div className="text-sm text-[#6f6f6f]">Positions (Mark Pricing)</div>
                                            <div className="mt-1 text-xs text-[#6f6f6f]">
                                                Source of truth: exchange reconciliation snapshots.
                                            </div>
                                        </div>
                                        {data.baseline.time ? null : (
                                            <div className="flex items-center gap-2 rounded-full border border-[#3a2d1a] bg-[#1a140c] px-3 py-1 text-xs text-amber-300">
                                                <TriangleAlert className="h-4 w-4" />
                                                Baseline not set yet
                                            </div>
                                        )}
                                    </div>

                                    <div className="mt-4 overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-[#1A1A1A] text-[#6f6f6f]">
                                                    <th className="py-3 text-left font-medium">Market</th>
                                                    <th className="py-3 text-right font-medium">Shares</th>
                                                    <th className="py-3 text-right font-medium">Mark</th>
                                                    <th className="py-3 text-right font-medium">Value</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sortedPositions.length > 0 ? (
                                                    sortedPositions.map((position) => (
                                                        <tr
                                                            key={position.assetId}
                                                            className="border-b border-[#1A1A1A] last:border-0"
                                                        >
                                                            <td className="py-3 text-white">
                                                                <div className="font-medium">{position.marketTitle}</div>
                                                                <div className="text-xs text-[#6f6f6f]">{position.outcome}</div>
                                                            </td>
                                                            <td className="py-3 text-right text-white">
                                                                {position.shares.toFixed(2)}
                                                            </td>
                                                            <td className="py-3 text-right text-white">
                                                                {position.markPrice !== null ? position.markPrice.toFixed(3) : "--"}
                                                            </td>
                                                            <td className="py-3 text-right text-white">
                                                                {position.marketValue !== null ? formatCurrency(position.marketValue) : "--"}
                                                            </td>
                                                        </tr>
                                                    ))
                                                ) : (
                                                    <tr>
                                                        <td colSpan={4} className="py-6 text-center text-[#6f6f6f]">
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
