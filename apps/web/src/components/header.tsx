"use client"

import { FinbroLogo } from "@/components/finbro-logo"
import { Settings2, LogOut } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function Header() {
  return (
    <header className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between p-6 bg-black/10 backdrop-blur-[120px]">
      <FinbroLogo className="text-white" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="h-10 w-10 rounded-full bg-gradient-to-br from-pink-500 to-orange-400 hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-white/20" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 bg-[#0D0D0D] border-[#1F1F1F] text-white">
          <DropdownMenuItem className="focus:bg-[#1F1F1F] focus:text-white cursor-pointer text-[#919191]">
            <Settings2 className="mr-2 h-4 w-4 text-[#919191]" />
            <span>Settings</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="focus:bg-[#1F1F1F] focus:text-white cursor-pointer text-[#919191]">
            <LogOut className="mr-2 h-4 w-4 text-[#919191]" />
            <span>Logout</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
