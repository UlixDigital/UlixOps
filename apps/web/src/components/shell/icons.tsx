import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  ClipboardCheck,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  Puzzle,
  Rocket,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
} from "lucide-react";
import type { NavIcon } from "@/lib/nav";

export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  sites: Server,
  approvals: ClipboardCheck,
  plugins: Puzzle,
  deployments: Rocket,
  backups: Archive,
  notifications: Bell,
  audit: ScrollText,
  settings: Settings,
  security: ShieldCheck,
  dns: Globe,
  monitoring: Activity,
  reports: BarChart3,
};
