"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'
import { UsersTable } from "@/components/users-table"
import { AddUserDialog } from "@/components/add-user-dialog"

export default function UsersPage() {
    const { data: users, error, isLoading } = useSWR('/api/users', fetcher)

    return (
        <div className="relative h-screen w-full bg-black text-white overflow-hidden">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex gap-6 p-6 pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-6 min-w-0">
                        <div className="flex items-center justify-between">
                            <h1 className="text-3xl font-bold">Followed Users</h1>
                            <AddUserDialog />
                        </div>

                        {isLoading ? (
                            <div className="text-gray-400">Loading users...</div>
                        ) : error ? (
                            <div className="text-red-500">Failed to load users</div>
                        ) : (
                            <UsersTable users={users} />
                        )}
                    </div>
                </main>
            </div>
        </div>
    )
}
