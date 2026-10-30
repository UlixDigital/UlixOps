"use client";
import { CornerDownLeft, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { OPEN_PALETTE_EVENT, THEME_EVENT, type Theme } from "@/lib/ui-prefs";
import { applyTheme } from "./top-bar";

export interface PaletteLink {
  href: string;
  label: string;
  group: string;
}

type Command = { id: string; label: string; group: string; run: () => void };

/** Cmd/Ctrl+K: jump to any page or run a quick action. A native <dialog>, so no inline styles. */
export function CommandPalette({
  links,
  signOut,
}: {
  links: PaletteLink[];
  signOut: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [, startTransition] = useTransition();

  const commands = useMemo<Command[]>(() => {
    const theme = (value: Theme, label: string): Command => ({
      id: `theme-${value}`,
      label,
      group: "Appearance",
      run: () => {
        applyTheme(value);
        window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: value }));
      },
    });
    return [
      ...links.map((link) => ({
        id: link.href,
        label: link.label,
        group: link.group,
        run: () => router.push(link.href),
      })),
      theme("light", "Use light theme"),
      theme("dark", "Use dark theme"),
      theme("system", "Use system theme"),
      {
        id: "sign-out",
        label: "Sign out",
        group: "Account",
        run: () => startTransition(() => void signOut()),
      },
    ];
  }, [links, router, signOut]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    const open = () => {
      setQuery("");
      setIndex(0);
      dialog.current?.showModal();
      input.current?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, open);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, open);
    };
  }, []);

  const choose = (command: Command | undefined) => {
    if (!command) return;
    dialog.current?.close();
    command.run();
  };

  return (
    <dialog
      ref={dialog}
      aria-label="Command palette"
      className="mx-auto mt-[12vh] w-[min(36rem,calc(100vw-2rem))] rounded-lg border bg-popover p-0 text-popover-foreground shadow-sm backdrop:bg-black/40"
    >
      <div className="flex items-center gap-2 border-b px-3">
        <Search aria-hidden className="size-4 text-muted-foreground" />
        <input
          ref={input}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[index]);
            }
          }}
          placeholder="Search pages and actions…"
          aria-label="Search pages and actions"
          aria-controls="palette-results"
          aria-activedescendant={matches[index] ? `palette-${matches[index].id}` : undefined}
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ul id="palette-results" role="listbox" className="max-h-80 overflow-y-auto p-1">
        {matches.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</li>
        )}
        {matches.map((command, i) => (
          <li
            key={command.id}
            id={`palette-${command.id}`}
            role="option"
            aria-selected={i === index}
            onMouseEnter={() => setIndex(i)}
            onClick={() => choose(command)}
            className={cn(
              "flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm",
              i === index && "bg-accent text-accent-foreground",
            )}
          >
            <span>{command.label}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {command.group}
              {i === index && <CornerDownLeft aria-hidden className="size-3" />}
            </span>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
