"use client";
// Top-bar bell + popups for unread notifications (A158). Polls quietly (the poll never extends
// the idle timeout) and marks a notification "seen" only when the user actually looks: opening
// the bell, clicking a popup, or visiting the Notifications page. A popup that appears on an
// unattended screen is not counted as seen.
import {
  NotificationList,
  type NotificationView,
  NOTIFICATION_EVENT_LABELS,
} from "@ulixops/shared";
import { AlertTriangle, Bell, CircleAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  acknowledgeAlertAction,
  markReadAction,
  markSeenAction,
} from "@/app/(app)/notifications/actions";
import { AlertStatusBadge, SEVERITY_BADGE } from "@/components/alert-status";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 30_000;
const MAX_POPUPS = 3;
/** Warnings fade after this; critical popups stay until the user acts. */
const WARNING_POPUP_MS = 12_000;

function canTake(n: NotificationView): boolean {
  const a = n.alert;
  if (!a?.actionable || a.ownerIsMe) return false;
  if (n.kind === "approval.requested") return false;
  return a.status === "OPEN" || a.status === "ACKNOWLEDGED";
}

export function NotificationBell({ initial }: { initial: NotificationList | null }) {
  const router = useRouter();
  const [data, setData] = useState<NotificationList | null>(initial);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const root = useRef<HTMLDivElement>(null);
  const stopped = useRef(false);

  // A navigation re-renders the layout with fresh server data.
  useEffect(() => setData(initial), [initial]);

  const poll = useCallback(async () => {
    if (stopped.current) return;
    try {
      const res = await fetch("/notifications/feed", { cache: "no-store" });
      if (res.status === 401) {
        stopped.current = true; // signed out or expired: the next navigation shows the login
        return;
      }
      if (!res.ok) return;
      const parsed = NotificationList.safeParse(await res.json());
      if (parsed.success) setData(parsed.data);
    } catch {
      // offline: try again next tick
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void poll();
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [poll]);

  const items = data?.notifications ?? [];
  const unread = data?.unreadCount ?? 0;

  const seen = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const at = new Date().toISOString();
    setData((d) =>
      d
        ? {
            ...d,
            notifications: d.notifications.map((n) =>
              ids.includes(n.id) && !n.seenAt ? { ...n, seenAt: at } : n,
            ),
          }
        : d,
    );
    void markSeenAction(ids);
  }, []);

  // Opening the bell = the user looked at everything listed in it.
  useEffect(() => {
    if (!open) return;
    seen(items.filter((n) => !n.seenAt).map((n) => n.id));
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
    // Only when the panel opens, not on every poll while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const popups = open
    ? []
    : items
        .filter((n) => !n.seenAt && n.severity !== "info" && !hidden.has(n.id))
        .slice(0, MAX_POPUPS);
  const morePopups =
    items.filter((n) => !n.seenAt && n.severity !== "info" && !hidden.has(n.id)).length -
    popups.length;

  // Warnings fade on their own (still unseen); critical ones wait for the user.
  useEffect(() => {
    const timers = popups
      .filter((n) => n.severity === "warning")
      .map((n) =>
        window.setTimeout(() => setHidden((h) => new Set(h).add(n.id)), WARNING_POPUP_MS),
      );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [popups.map((n) => n.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (run: () => Promise<{ error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const result = await run();
      if (result.error) setError(result.error);
      await poll();
      router.refresh();
    });

  const form = (values: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(k, v);
    return f;
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `Notifications: ${unread} unread` : "Notifications"}
        className="relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
      >
        <Bell aria-hidden className="size-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Unread notifications"
          className="absolute right-0 z-50 mt-2 w-[min(26rem,calc(100vw-2rem))] rounded-lg border bg-popover text-popover-foreground shadow-sm"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <p className="text-sm font-medium">
              {unread ? `${unread} unread` : "You're all caught up"}
            </p>
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-link hover:underline"
            >
              View all
            </Link>
          </div>
          {error && <p className="border-b px-3 py-2 text-xs text-destructive">{error}</p>}
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              New alerts show up here and pop up in the corner.
            </p>
          ) : (
            <ul className="max-h-[min(28rem,70vh)] divide-y overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className="grid gap-1.5 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        "mt-0.5 rounded px-1 text-[10px] font-semibold uppercase",
                        SEVERITY_BADGE[n.severity],
                      )}
                    >
                      {n.severity}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={n.title}>
                        {n.title}
                      </p>
                      <p className="line-clamp-2 text-xs break-words text-muted-foreground">
                        {n.body}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-1">
                    <span className="text-[11px] text-muted-foreground">
                      {timeAgo(n.createdAt)}
                    </span>
                    {n.alert?.actionable && <AlertStatusBadge status={n.alert.status} />}
                    {n.alert?.ownerName && n.alert.status === "ACKNOWLEDGED" && (
                      <span className="text-[11px] text-muted-foreground">
                        {n.alert.ownerIsMe ? "you're on it" : `${n.alert.ownerName} is on it`}
                      </span>
                    )}
                    <span className="ml-auto flex gap-1">
                      {canTake(n) && n.alert && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            act(() =>
                              acknowledgeAlertAction({}, form({ alertId: n.alert?.id ?? "" })),
                            )
                          }
                          className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                        >
                          I&apos;m on it
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => act(() => markReadAction({}, form({ id: n.id })))}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        Mark read
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            Took an alert? Report what you did from{" "}
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="font-medium text-link hover:underline"
            >
              Notifications
            </Link>
            .
          </div>
        </div>
      )}

      {popups.length > 0 && (
        <div
          aria-live="assertive"
          className="fixed top-16 right-4 z-40 grid w-[min(24rem,calc(100vw-2rem))] gap-2"
        >
          {popups.map((n) => {
            const Icon = n.severity === "critical" ? CircleAlert : AlertTriangle;
            return (
              <div
                key={n.id}
                role="alert"
                className={cn(
                  "rounded-lg border bg-popover p-3 text-popover-foreground shadow-sm transition-opacity duration-150",
                  n.severity === "critical" ? "border-destructive/40" : "border-warning/40",
                )}
              >
                <div className="flex items-start gap-2">
                  <Icon
                    aria-hidden
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      n.severity === "critical" ? "text-destructive" : "text-warning",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{n.title}</p>
                    <p className="line-clamp-2 text-xs break-words text-muted-foreground">
                      {n.body}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {NOTIFICATION_EVENT_LABELS[n.kind]} · {timeAgo(n.createdAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      seen([n.id]);
                      setHidden((h) => new Set(h).add(n.id));
                    }}
                    aria-label={`Dismiss: ${n.title}`}
                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  {canTake(n) && n.alert && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        act(() => acknowledgeAlertAction({}, form({ alertId: n.alert?.id ?? "" })))
                      }
                      className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                    >
                      I&apos;m on it
                    </button>
                  )}
                  <Link
                    href={`/notifications#n-${n.id}`}
                    onClick={() => seen([n.id])}
                    className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                  >
                    View
                  </Link>
                </div>
              </div>
            );
          })}
          {morePopups > 0 && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="justify-self-end rounded-md border bg-popover px-2.5 py-1 text-xs font-medium shadow-sm hover:bg-accent"
            >
              +{morePopups} more unseen
            </button>
          )}
        </div>
      )}
    </div>
  );
}
