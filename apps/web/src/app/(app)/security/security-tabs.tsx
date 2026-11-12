// Security sections: vulnerabilities (feed), malware scans (A143), file integrity (A144).
import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/security", label: "Vulnerabilities" },
  { href: "/security/malware", label: "Malware scans" },
  { href: "/security/integrity", label: "File integrity" },
] as const;

export function SecurityTabs({ active }: { active: (typeof TABS)[number]["href"] }) {
  return (
    <nav aria-label="Security sections" className="flex flex-wrap gap-1 border-b pb-2">
      {TABS.map((tab) => (
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
