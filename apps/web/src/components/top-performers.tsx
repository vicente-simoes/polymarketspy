"use client"

import { Trophy, TrendingUp, TrendingDown } from 'lucide-react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'

export function TopPerformers() {
    const { data, error, isLoading } = useSWR('/api/overview', fetcher, { refreshInterval: 10000 })
    const topMarkets = data?.analytics?.topMarkets || []

    if (isLoading) return <div className="h-64 bg-[#0D0D0D] rounded-2xl flex items-center justify-center text-gray-400">Loading top performers...</div>

    const topUsers = data?.analytics?.topUsers || []

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Positions */}
            <div className="bg-[#0D0D0D] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-4">
                    <Trophy className="h-5 w-5 text-yellow-500" />
                    <h3 className="text-xl font-medium text-white">Top Positions (Unrealized)</h3>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="text-gray-500 border-b border-gray-800 text-sm">
                                <th className="pb-3 pl-2">Market / Outcome</th>
                                <th className="pb-3 text-right pr-2">Unrealized PnL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {topMarkets.length > 0 ? (
                                topMarkets.map((m: any, idx: number) => (
                                    <tr key={idx} className="border-b border-gray-800 hover:bg-[#1A1A1A] transition-colors last:border-0">
                                        <td className="py-3 pl-2 max-w-[200px]">
                                            <div className="font-medium text-sm text-white truncate" title={m.marketTitle}>
                                                {m.marketTitle}
                                            </div>
                                            <div className="text-xs text-gray-500 font-mono">
                                                {m.outcomeLabel}
                                            </div>
                                        </td>
                                        <td className={`py-3 pr-2 text-right font-medium ${m.pnl >= 0 ? 'text-[#86efac]' : 'text-red-400'}`}>
                                            {m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(2)}
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={2} className="py-4 text-center text-gray-500 text-sm">No open positions yet</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Top Users (Mock/Placeholder for now until API expanded) */}
            <div className="bg-[#0D0D0D] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-4">
                    <TrendingUp className="h-5 w-5 text-blue-500" />
                    <h3 className="text-xl font-medium text-white">Top Users</h3>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="text-gray-500 border-b border-gray-800 text-sm">
                                <th className="pb-3 pl-2">User</th>
                                <th className="pb-3 text-right">Trades</th>
                                <th className="pb-3 text-right pr-2">PnL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {topUsers.length > 0 ? (
                                topUsers.map((u: any, idx: number) => (
                                    <tr key={idx} className="border-b border-gray-800 hover:bg-[#1A1A1A] transition-colors last:border-0">
                                        <td className="py-3 pl-2 font-medium text-sm text-white">
                                            {u.label}
                                        </td>
                                        <td className="py-3 text-right text-sm text-gray-400">
                                            {u.count}
                                        </td>
                                        <td className={`py-3 pr-2 text-right font-medium ${u.pnl >= 0 ? 'text-[#86efac]' : 'text-red-400'}`}>
                                            {u.pnl >= 0 ? '+' : ''}${u.pnl.toFixed(2)}
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={3} className="py-4 text-center text-gray-500 text-sm">No active users yet</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}
