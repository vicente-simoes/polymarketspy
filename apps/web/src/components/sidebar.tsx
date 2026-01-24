"use client"

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { signOut } from 'next-auth/react'

import { navItems } from "@/components/nav-items"

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="sticky top-24 h-[calc(100vh-8rem)] md:w-48 lg:w-64 bg-[#0D0D0D] rounded-2xl hidden md:flex flex-col p-8 overflow-y-auto">
      <nav className="flex flex-col gap-6">
        {navItems.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-4 transition-colors ${isActive ? 'text-[#E7E7E7]' : 'text-[#919191] hover:text-[#E7E7E7]'
                }`}
            >
              <Icon className="h-6 w-6" />
              <span className="text-sm font-medium tracking-wide">{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto pt-8 border-t border-[#1F1F1F] flex flex-col gap-8">
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer w-full text-left"
        >
          <LogOut className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">LOGOUT</span>
        </button>
      </div>
    </aside>
  )
}
