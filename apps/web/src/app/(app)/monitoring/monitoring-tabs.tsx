// Monitoring sections (spec screen 16): uptime (P3-2, A149), SSL & domain expiry (P3-1, A148).
import Link from "next/link";
import { cn } from "@/lib/utils";

const ALL_TABS = [
  { href: "/monitoring/uptime", label: "Uptime" },
  { href: "/monitoring/ssl", label: "SSL & domains" },
  { href: "/monitoring/php-errors", label: "PHP errors" },
  { href: "/monitoring/visual", label: "Visual checks" },
] as const;

export type MonitoringTabHref = (typeof ALL_TABS)[number]["href"];

export function MonitoringTabs({
  active,
  showVisual = true,
}: {
  active: MonitoringTabHref;
  /** Client Viewer hides Visual checks (A178). */
  showVisual?: boolean;
}) {
  const tabs = showVisual ? ALL_TABS : ALL_TABS.filter((t) => t.href !== "/monitoring/visual");
  return (
    <nav aria-label="Monitoring sections" className="flex flex-wrap gap-1 border-b pb-2">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === active ? "page" : undefined}
          className={cn(
            "rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150",
            tab.href === active
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
