"use client"

import { FinbroLogo } from "@/components/finbro-logo"
import { navItems } from "@/components/nav-items"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Menu, LogOut } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"

export function Header() {
  const pathname = usePathname()

  return (
    <header className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between p-4 md:p-6 bg-black/10 backdrop-blur-[120px]">
      <div className="flex items-center gap-3">
        <Sheet>
          <SheetTrigger asChild>
            <button
              type="button"
              className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white hover:bg-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5" />
            </button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="bg-[#0D0D0D] border-[#1F1F1F] text-white p-0"
          >
            <SheetHeader className="p-5">
              <SheetTitle className="text-white">
                <Link href="/" className="inline-flex items-center">
                  <FinbroLogo className="text-white" />
                </Link>
              </SheetTitle>
            </SheetHeader>

            <nav className="px-3 pb-3">
              <div className="flex flex-col gap-1">
                {navItems.map((item) => {
                  const isActive = pathname === item.href
                  const Icon = item.icon
                  return (
                    <SheetClose asChild key={item.href}>
                      <Link
                        href={item.href}
                        className={[
                          "flex items-center gap-3 rounded-xl px-3 py-3 transition-colors",
                          isActive
                            ? "bg-white/10 text-white"
                            : "text-[#c0c0c0] hover:bg-white/5 hover:text-white",
                        ].join(" ")}
                      >
                        <Icon className="h-5 w-5 shrink-0" />
                        <span className="text-sm font-medium tracking-wide">
                          {item.label}
                        </span>
                      </Link>
                    </SheetClose>
                  )
                })}
              </div>
            </nav>

            <div className="mt-auto border-t border-[#1F1F1F] p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
              <SheetClose asChild>
                <button
                  type="button"
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[#c0c0c0] hover:bg-white/5 hover:text-white transition-colors"
                >
                  <LogOut className="h-5 w-5 shrink-0" />
                  <span className="text-sm font-medium tracking-wide">LOGOUT</span>
                </button>
              </SheetClose>
            </div>
          </SheetContent>
        </Sheet>

        <Link href="/" className="inline-flex items-center">
          <FinbroLogo className="text-white" />
        </Link>
      </div>
    </header>
  )
}
