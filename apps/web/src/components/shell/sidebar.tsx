"use client";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { NavItem } from "@/lib/nav";
import { SIDEBAR_COOKIE } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";
import { NAV_ICONS } from "./icons";

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavList({
  main,
  later,
  collapsed = false,
  onNavigate,
}: {
  main: NavItem[];
  later: NavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const row = (item: NavItem) => {
    const Icon = NAV_ICONS[item.icon];
    const body = (
      <>
        <Icon aria-hidden className="size-4 shrink-0" />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {!collapsed && item.soon && (
          <span className="ml-auto rounded bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-medium text-sidebar-accent-foreground/80">
            Soon
          </span>
        )}
      </>
    );
    const base = cn(
      "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm",
      collapsed && "justify-center px-0",
    );
    if (item.soon) {
      return (
        <li key={item.href}>
          <span
            aria-disabled="true"
            title={`${item.label}: coming soon (${item.soon})`}
            className={cn(base, "cursor-default text-sidebar-foreground/45")}
          >
            {body}
          </span>
        </li>
      );
    }
    const active = isActive(pathname, item.href);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          onClick={onNavigate}
          title={collapsed ? item.label : undefined}
          aria-current={active ? "page" : undefined}
          className={cn(
            base,
            "transition-colors duration-150",
            active
              ? "bg-sidebar-primary font-medium text-sidebar-primary-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          {body}
        </Link>
      </li>
    );
  };
  return (
    <nav aria-label="Main" className="grid gap-6">
      <ul className="grid gap-0.5">{main.map(row)}</ul>
      <div className="grid gap-1">
        {!collapsed && (
          <p className="px-2.5 text-[11px] font-medium tracking-wide text-sidebar-foreground/50 uppercase">
            Later phases
          </p>
        )}
        <ul className="grid gap-0.5">{later.map(row)}</ul>
      </div>
    </nav>
  );
}

export function Sidebar({
  main,
  later,
  initiallyCollapsed,
}: {
  main: NavItem[];
  later: NavItem[];
  initiallyCollapsed: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=strict; secure`;
  };
  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-150 md:flex",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div className={cn("flex h-14 items-center px-4", collapsed && "justify-center px-0")}>
        <Link href="/" className="text-sm font-semibold tracking-tight" title="UlixOps">
          {collapsed ? "U" : "UlixOps"}
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <NavList main={main} later={later} collapsed={collapsed} />
      </div>
      <div className="border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          <Toggle aria-hidden className="size-4" />
          {!collapsed && "Collapse"}
        </button>
      </div>
    </aside>
  );
}
