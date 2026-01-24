"use client"

import { ChevronsUpDown, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useToast } from "@/components/ui/use-toast"
import { useSWRConfig } from "swr"

interface UserMetrics {
    shadowEquity: number
    execEquity: number
    execRealizedPnl: number
    execUnrealizedPnl: number
}

interface User {
    id: string
    label: string
    profileWallet: string
    enabled: boolean
    proxies: any[]
    metrics: UserMetrics
}

interface UsersTableProps {
    users: User[]
}

export function UsersTable({ users }: UsersTableProps) {
    const { toast } = useToast()
    const { mutate } = useSWRConfig()

    const formatCurrency = (val: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2
        }).format(val)
    }

    const formatWallet = (wallet: string) => {
        return `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}`
    }

    const handleToggle = async (userId: string, currentStatus: boolean) => {
        const newStatus = !currentStatus

        // Optimistic update
        const updatedUsers = users.map(user =>
            user.id === userId ? { ...user, enabled: newStatus } : user
        )
        mutate("/api/users", updatedUsers, false)

        try {
            const response = await fetch("/api/users/toggle", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: userId, enabled: newStatus }),
            })

            if (!response.ok) {
                throw new Error("Failed to update status")
            }

            const updatedUser = await response.json()

            // Authoritative update: Merge server response into current list
            const finalUsers = users.map(user =>
                user.id === userId ? { ...user, enabled: updatedUser.enabled } : user
            )
            mutate("/api/users", finalUsers, false) // Commit without revalidation first

            // Eventually consisteny check
            mutate("/api/users")
        } catch (error) {
            // Revert on error
            mutate("/api/users")
            toast({
                variant: "destructive",
                title: "Error",
                description: "Failed to update user status",
            })
        }
    }

    return (
        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A]">
            <div className="p-4 md:p-6">
                <div className="md:hidden flex flex-col gap-3">
                    {users.map((user) => {
                        const pnl = user.metrics.execRealizedPnl + user.metrics.execUnrealizedPnl
                        const isProfitable = pnl >= 0
                        return (
                            <div
                                key={user.id}
                                className="rounded-2xl border border-[#27272A] bg-[#111111] p-4"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-3">
                                            <div className="h-8 w-8 rounded-full bg-[#1A1A1A] flex items-center justify-center text-[#919191] font-bold text-xs">
                                                {user.label.substring(0, 2).toUpperCase()}
                                            </div>
                                            <div className="min-w-0">
                                                <a
                                                    href={`https://polymarket.com/@${user.label}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="block font-bold text-white hover:text-[#86efac] hover:underline transition-all truncate"
                                                >
                                                    {user.label}
                                                </a>
                                                <div className="text-xs text-[#6f6f6f] font-mono truncate">
                                                    {formatWallet(user.profileWallet)}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => handleToggle(user.id, user.enabled)}
                                        className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                                            user.enabled
                                                ? "bg-[#86efac] text-black hover:bg-[#4ade80]"
                                                : "bg-[#2a2a2a] text-[#9b9b9b] hover:bg-[#3a3a3a]"
                                        }`}
                                        aria-pressed={user.enabled}
                                    >
                                        {user.enabled ? "Active" : "Paused"}
                                    </button>
                                </div>

                                <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                                    <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                        <div className="text-[#6f6f6f] uppercase tracking-wider">
                                            Shadow
                                        </div>
                                        <div className="mt-1 text-white font-mono">
                                            {formatCurrency(user.metrics.shadowEquity)}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                        <div className="text-[#6f6f6f] uppercase tracking-wider">
                                            Exec
                                        </div>
                                        <div className="mt-1 text-white font-mono">
                                            {formatCurrency(user.metrics.execEquity)}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3 col-span-2">
                                        <div className="text-[#6f6f6f] uppercase tracking-wider">
                                            Exec PnL
                                        </div>
                                        <div
                                            className={`mt-1 font-mono font-medium ${
                                                isProfitable ? "text-[#86efac]" : "text-[#EF4444]"
                                            }`}
                                        >
                                            {formatCurrency(pnl)}
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-4 flex justify-end">
                                    <Link
                                        href={`/users/${user.id}`}
                                        className="inline-flex items-center justify-end gap-1 text-sm text-[#919191] hover:text-white transition-colors"
                                    >
                                        Details
                                        <ExternalLink className="h-3 w-3" />
                                    </Link>
                                </div>
                            </div>
                        )
                    })}
                </div>

                <div className="hidden md:block overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="text-[#919191] text-sm border-b border-[#27272A]">
                                <th className="pb-4 text-left font-medium pl-2">
                                    <div className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors">
                                        User
                                        <ChevronsUpDown className="h-4 w-4" />
                                    </div>
                                </th>
                                <th className="pb-4 text-left font-medium">Wallet</th>
                                <th className="pb-4 text-center font-medium">Status</th>
                                <th className="pb-4 text-center font-medium">Shadow Equity</th>
                                <th className="pb-4 text-center font-medium">Exec Equity</th>
                                <th className="pb-4 text-center font-medium">Exec PnL</th>
                                <th className="pb-4 text-right font-medium pr-2">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((user) => {
                                const pnl =
                                    user.metrics.execRealizedPnl + user.metrics.execUnrealizedPnl
                                const isProfitable = pnl >= 0

                                return (
                                    <tr
                                        key={user.id}
                                        className="group transition-colors border-b border-[#27272A] last:border-0 hover:bg-[#1A1A1A]"
                                    >
                                        <td className="py-4 pl-2 rounded-l-xl">
                                            <div className="flex items-center gap-3">
                                                <div className="h-8 w-8 rounded-full bg-[#1A1A1A] flex items-center justify-center text-[#919191] font-bold text-xs">
                                                    {user.label.substring(0, 2).toUpperCase()}
                                                </div>
                                                <a
                                                    href={`https://polymarket.com/@${user.label}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="font-bold text-white hover:text-[#86efac] hover:underline transition-all"
                                                >
                                                    {user.label}
                                                </a>
                                            </div>
                                        </td>
                                        <td className="py-4 text-sm text-[#919191] font-mono">
                                            {formatWallet(user.profileWallet)}
                                        </td>
                                        <td className="py-4 text-center">
                                            <button
                                                type="button"
                                                onClick={() => handleToggle(user.id, user.enabled)}
                                                className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                                                    user.enabled
                                                        ? "bg-[#86efac] text-black hover:bg-[#4ade80]"
                                                        : "bg-[#2a2a2a] text-[#9b9b9b] hover:bg-[#3a3a3a]"
                                                }`}
                                                aria-pressed={user.enabled}
                                            >
                                                {user.enabled ? "Active" : "Paused"}
                                            </button>
                                        </td>
                                        <td className="py-4 text-center text-white font-medium font-mono">
                                            {formatCurrency(user.metrics.shadowEquity)}
                                        </td>
                                        <td className="py-4 text-center text-white font-medium font-mono">
                                            {formatCurrency(user.metrics.execEquity)}
                                        </td>
                                        <td
                                            className={`py-4 text-center font-medium font-mono ${
                                                isProfitable ? "text-[#86efac]" : "text-[#EF4444]"
                                            }`}
                                        >
                                            {formatCurrency(pnl)}
                                        </td>
                                        <td className="py-4 text-right pr-2 rounded-r-xl">
                                            <Link
                                                href={`/users/${user.id}`}
                                                className="inline-flex items-center justify-end gap-1 text-sm text-[#919191] hover:text-white transition-colors"
                                            >
                                                Details
                                                <ExternalLink className="h-3 w-3" />
                                            </Link>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}
