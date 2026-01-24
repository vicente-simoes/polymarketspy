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
} from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
}

export const navItems: NavItem[] = [
  { href: "/", label: "DASHBOARD", icon: Blocks },
  { href: "/users", label: "FOLLOWED USERS", icon: Users },
  { href: "/portfolio", label: "GLOBAL PORTFOLIO", icon: PieChart },
  { href: "/trades", label: "TRADES", icon: Activity },
  { href: "/copy-attempts", label: "COPY ATTEMPTS", icon: ClipboardList },
  { href: "/markets", label: "MARKETS", icon: ShoppingCart },
  { href: "/config", label: "CONFIG", icon: Settings },
  { href: "/status", label: "SYSTEM STATUS", icon: Server },
]
