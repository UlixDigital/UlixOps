"use client";
import { LogOut, Menu, Monitor, Moon, Search, Sun, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import type { NavItem } from "@/lib/nav";
import { OPEN_PALETTE_EVENT, THEME_COOKIE, THEME_EVENT, type Theme } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";
import { NavList } from "./sidebar";

/** Applies a theme now and remembers it; `system` follows the operating system. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (theme !== "system") root.classList.add(theme);
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=strict; secure`;
}

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
];

export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    const sync = (event: Event) => setTheme((event as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  const index = THEMES.findIndex((t) => t.value === theme);
  const current = THEMES[index] ?? THEMES[0];
  const next = THEMES[(index + 1) % THEMES.length] ?? THEMES[0];
  if (!current || !next) return null;
  const Icon = current.Icon;
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next.value);
        setTheme(next.value);
      }}
      aria-label={`${current.label}. Switch to ${next.label.toLowerCase()}`}
      title={current.label}
      className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
    >
      <Icon aria-hidden className="size-4" />
    </button>
  );
}

export function SearchButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
      className="inline-flex h-9 w-full max-w-sm items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      <Search aria-hidden className="size-4" />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}

export function MobileNav({ main, later }: { main: NavItem[]; later: NavItem[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => dialog.current?.close();
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-label="Open menu"
        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
      >
        <Menu aria-hidden className="size-5" />
      </button>
      <dialog
        ref={dialog}
        aria-label="Menu"
        className="m-0 h-dvh max-h-none w-72 max-w-[85vw] bg-sidebar-brand p-0 text-sidebar-foreground backdrop:bg-black/40"
      >
        <div className="flex h-16 items-center justify-between px-4">
          <BrandLogo href={null} />
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="rounded-md p-1.5 hover:bg-sidebar-accent"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <div className="px-2 pb-4">
          <NavList main={main} later={later} onNavigate={close} />
        </div>
      </dialog>
    </>
  );
}

export function UserMenu({
  email,
  name,
  roleLabel,
  signOut,
}: {
  email: string;
  name: string | null;
  roleLabel: string;
  signOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const initials =
    (name || email)
      .replace(/[^A-Za-z ]/g, " ")
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "U";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="inline-flex size-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
      >
        {initials}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium">{name || email}</p>
            <p className="truncate text-xs text-muted-foreground">
              {name ? `${email} · ` : ""}
              {roleLabel}
            </p>
          </div>
          <div className="my-1 border-t" />
          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
          >
            <UserRound aria-hidden className="size-4" /> My account
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              role="menuitem"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent",
              )}
            >
              <LogOut aria-hidden className="size-4" /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
