import type { LucideIcon } from "lucide-react"
import {
  Activity,
  Blocks,
  ClipboardList,
  Server,
  Settings,
  ShoppingCart,
  Users,
  PieChart,
  Zap,
} from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
}

export const navItems: NavItem[] = [
  { href: "/", label: "DASHBOARD", icon: Blocks },
  { href: "/users", label: "FOLLOWED USERS", icon: Users },
  { href: "/paper-portfolio", label: "PAPER PORTFOLIO", icon: PieChart },
  { href: "/real-portfolio", label: "REAL PORTFOLIO", icon: PieChart },
  { href: "/trades", label: "TRADES", icon: Activity },
  { href: "/paper-trades", label: "PAPER TRADES", icon: ClipboardList },
  { href: "/live-trades", label: "LIVE TRADES", icon: Zap },
  { href: "/markets", label: "MARKETS", icon: ShoppingCart },
  { href: "/config", label: "CONFIG", icon: Settings },
  { href: "/status", label: "SYSTEM STATUS", icon: Server },
]
