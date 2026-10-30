"use client";
// Site detail tabs (spec screen 5). Keeps the chosen environment (?env=staging) across tabs.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { name: "Overview", path: "" },
  { name: "Plugins & themes", path: "/plugins" },
  { name: "Snapshots & backups", path: "/snapshots" },
  { name: "Emergency", path: "/emergency" },
  { name: "Logs", path: "/logs" },
];

const LATER_TABS = [
  { name: "Deployments", when: "Step 10" },
  { name: "Security", when: "Phase 2" },
  { name: "DNS", when: "Phase 3" },
  { name: "Uptime & SSL", when: "Phase 3" },
  { name: "Visual checks", when: "Phase 4" },
];

export function SiteTabs({ siteId }: { siteId: string }) {
  const pathname = usePathname();
  const env = useSearchParams().get("env") === "staging" ? "?env=staging" : "";
  const base = `/sites/${siteId}`;
  return (
    <nav aria-label="Site sections" className="flex flex-wrap gap-1 border-b pb-2">
      {TABS.map((tab) => {
        const href = `${base}${tab.path}`;
        const active = pathname === href;
        return (
          <Link
            key={tab.name}
            href={`${href}${env}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150",
              active
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.name}
          </Link>
        );
      })}
      {LATER_TABS.map((tab) => (
        <span
          key={tab.name}
          title={`${tab.name}: coming soon (${tab.when})`}
          className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground/70"
        >
          {tab.name}
          <span className="ml-1 text-[10px]">soon</span>
        </span>
      ))}
    </nav>
  );
}
