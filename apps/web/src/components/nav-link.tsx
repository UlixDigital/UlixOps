"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function NavLink({
  href,
  children,
  exact = false,
}: {
  href: string;
  children: ReactNode;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact || href === "/" ? pathname === href : pathname.startsWith(href);
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
