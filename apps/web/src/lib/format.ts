export const ROLE_LABELS = { ADMIN: "Admin", DEVELOPER: "Developer", VIEWER: "Viewer" } as const;

/** "2026-10-29 14:05 UTC": one unambiguous time for a team across time zones. */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "Chrome on Linux" from a user-agent string; good enough to recognise a device. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad/.test(userAgent)
        ? "iOS"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? userAgent.slice(0, 40);
}
