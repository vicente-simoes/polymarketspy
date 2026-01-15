"use client"

import { Wallet } from 'lucide-react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'

export function DashboardMetrics() {
  const { data, error, isLoading } = useSWR('/api/overview', fetcher, { refreshInterval: 10000 })

  if (isLoading) return <div className="p-6 bg-[#0D0D0D] rounded-2xl text-gray-400">Loading metrics...</div>
  if (error) return <div className="p-6 bg-[#0D0D0D] rounded-2xl text-red-500">Failed to load metrics</div>

  // Computed display values
  const equity = data?.equity || 0
  const exposure = data?.exposure || 0
  const pnl = data?.pnl || 0
  const pnlIsPositive = pnl >= 0

  // Approximate invested as equity - pnl (assuming pnl is cumulative)
  // Or utilize exposure as "Invested" (active positions)
  const invested = exposure

  // Net returns %
  const startEquity = equity - pnl
  const returnPct = startEquity > 0 ? (pnl / startEquity) * 100 : 0

  // New Analytics
  const winRate = data?.analytics?.winRate || 0
  const maxDrawdown = data?.analytics?.maxDrawdown || 0
  const totalClosed = data?.analytics?.totalClosedPositions || 0

  return (
    <div className="flex flex-col xl:flex-row gap-8 xl:items-center justify-between p-6 bg-[#0D0D0D] rounded-2xl">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-gray-400">
          <Wallet className="h-5 w-5" />
          <span className="text-lg">Equity</span>
        </div>
        <div className="text-5xl md:text-4xl lg:text-5xl font-bold text-white">
          ${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-8 xl:gap-16">
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">Exposure</span>
          <span className="text-2xl md:text-xl lg:text-2xl font-semibold text-white">
            ${invested.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">Total PnL</span>
          <span className={`text-2xl md:text-xl lg:text-2xl font-semibold ${pnlIsPositive ? 'text-[#86efac]' : 'text-red-500'}`}>
            {pnlIsPositive ? '+' : ''}${pnl.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">Win Rate</span>
          <span className="text-2xl md:text-xl lg:text-2xl font-semibold text-white">
            {winRate.toFixed(1)}% <span className="text-xs text-gray-500">({totalClosed})</span>
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">Max Drawdown</span>
          <span className="text-2xl md:text-xl lg:text-2xl font-semibold text-red-400">
            -{maxDrawdown.toFixed(2)}%
          </span>
        </div>
      </div>
    </div>
  )
}
