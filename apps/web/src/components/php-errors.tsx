// PHP error log groups and level badges (A159). Server-safe: plain markup and <details>.
import {
  ERROR_LEVEL_LABELS,
  type ErrorGroup,
  type ErrorLevel,
  type LoggingView,
} from "@ulixops/shared";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const TONES: Record<ErrorLevel, string> = {
  fatal: "bg-destructive/10 text-destructive",
  parse: "bg-destructive/10 text-destructive",
  database: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  notice: "bg-muted text-muted-foreground",
  deprecated: "bg-muted text-muted-foreground",
  other: "bg-muted text-muted-foreground",
};

export function LevelBadge({ level }: { level: ErrorLevel }) {
  return (
    <span
      className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", TONES[level])}
    >
      {ERROR_LEVEL_LABELS[level]}
    </span>
  );
}

/** "plugin:woocommerce" → "Plugin: woocommerce". */
export function sourceText(source: string | null): string | null {
  if (!source) return null;
  if (source === "core") return "WordPress core";
  if (source === "host") return "Host (WP Engine drop-in)";
  const [kind, name] = source.split(":");
  const label = kind === "plugin" ? "Plugin" : kind === "theme" ? "Theme" : "Must-use plugin";
  return `${label}: ${name}`;
}

export function ErrorGroupList({ groups }: { groups: ErrorGroup[] }) {
  return (
    <ul className="min-w-0 divide-y rounded-lg border">
      {groups.map((g, i) => (
        <li key={`${g.level}-${i}`} className="grid min-w-0 gap-1.5 px-3 py-2.5 text-sm">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <LevelBadge level={g.level} />
            {g.count24h > 0 ? (
              <span className="text-xs font-medium">×{g.count24h} in 24 h</span>
            ) : (
              <span className="text-xs text-muted-foreground">none in 24 h</span>
            )}
            <span className="text-xs text-muted-foreground">
              ×{g.count} in the log
              {g.lastAt && (
                <>
                  {" · last "}
                  <span title={formatUtc(g.lastAt)}>{timeAgo(g.lastAt)}</span>
                </>
              )}
            </span>
            {sourceText(g.source) && (
              <span
                className="ml-auto max-w-full truncate rounded-md border px-1.5 py-0.5 text-xs"
                title={sourceText(g.source) ?? undefined}
              >
                {sourceText(g.source)}
              </span>
            )}
          </div>
          <p className="font-mono text-xs [overflow-wrap:anywhere]">{g.message}</p>
          {g.file && (
            <p className="font-mono text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
              {g.file}
              {g.line !== null ? `:${g.line}` : ""}
            </p>
          )}
          {g.trace.length > 0 && (
            <details className="min-w-0 text-xs">
              <summary className="cursor-pointer text-muted-foreground">Stack trace</summary>
              <pre className="mt-1 max-w-full overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                {g.trace.join("\n")}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

const LOGGING: Record<LoggingView["state"], { label: string; tone: string }> = {
  on: { label: "Logging on", tone: "bg-success/10 text-success" },
  off: { label: "Logging off", tone: "bg-muted text-muted-foreground" },
  custom: { label: "Logs to a custom path", tone: "bg-muted text-muted-foreground" },
  unknown: { label: "Logging unknown", tone: "bg-muted text-muted-foreground" },
};

/** Whether PHP errors are logged, and whether UlixOps manages that via its mu-plugin (A167). */
export function LoggingBadge({ logging }: { logging: LoggingView }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
          LOGGING[logging.state].tone,
        )}
      >
        {LOGGING[logging.state].label}
        {logging.managed ? (logging.viaPlugin ? " · by UlixOps (mu-plugin)" : " · by UlixOps") : ""}
      </span>
      {logging.display && (
        <span
          className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-destructive"
          title="WP_DEBUG is on and WP_DEBUG_DISPLAY isn't false: visitors can see PHP errors"
        >
          Errors shown to visitors
        </span>
      )}
    </span>
  );
}
