import { cn } from "@/lib/utils"

export function FinbroLogo({ className }: { className?: string }) {
  return (
    <span className={cn("font-brand text-2xl font-semibold tracking-[0.02em] leading-none text-white", className)}>
      PolymarketSpy
    </span>
  )
}
