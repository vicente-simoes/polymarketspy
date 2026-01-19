"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import {
    Bar,
    BarChart,
    CartesianGrid,
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
        exposurePct: number
        maxTotalExposurePct: number
        riskUtilizationPct: number
        maxDrawdownPct: number
        currentDrawdownPct: number
        maxDrawdownLimitPct: number
        drawdownUtilizationPct: number
    }
}

const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2
    }).format(value)

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
    const { data, error, isLoading } = useSWR<GlobalPortfolioResponse>(
        "/api/portfolio/global",
        fetcher,
        { refreshInterval: 10000 }
    )

    const metrics = data?.metrics
    const pnl = metrics?.pnl ?? 0
    const pnlPositive = pnl >= 0
    const riskUtilization = metrics?.riskUtilizationPct ?? 0
    const drawdownUtilization = metrics?.drawdownUtilizationPct ?? 0

    const riskStatus =
        riskUtilization > 90 ? "bad" : riskUtilization > 70 ? "warn" : "good"
    const drawdownStatus =
        drawdownUtilization > 90 ? "bad" : drawdownUtilization > 70 ? "warn" : "good"

    return (
        <div className="relative h-screen w-full bg-black text-white overflow-hidden">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex gap-6 p-6 pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-6 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <p className="text-sm text-[#6f6f6f]">Global Portfolio</p>
                                <h1 className="text-3xl font-bold text-white">Executable Portfolio</h1>
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
                                        value={`${pnlPositive ? "+" : ""}${formatCurrency(pnl)}`}
                                        valueClassName={pnlPositive ? "text-[#86efac]" : "text-red-400"}
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

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                    <div className="text-sm text-[#6f6f6f]">Open Positions</div>
                                    <div className="mt-4 overflow-x-auto">
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
                                                {data.positions.length > 0 ? (
                                                    data.positions.map((position) => {
                                                        const marketValue =
                                                            position.marketValue ?? position.invested
                                                        return (
                                                            <tr
                                                                key={`${position.assetId ?? "unknown"}-${position.marketId ?? "market"}`}
                                                                className="border-b border-[#1A1A1A] last:border-0"
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
