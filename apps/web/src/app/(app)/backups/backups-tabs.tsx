// Backups sections: quick snapshots (step 8), full Google Drive backups (A145) and restoring
// them (A152).
import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/backups", label: "Quick snapshots" },
  { href: "/backups/full", label: "Full backups (Google Drive)" },
  { href: "/backups/restore", label: "Restore" },
] as const;

export function BackupsTabs({ active }: { active: (typeof TABS)[number]["href"] }) {
  return (
    <nav aria-label="Backup sections" className="flex flex-wrap gap-1 border-b pb-2">
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
