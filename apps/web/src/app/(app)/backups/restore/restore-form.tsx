"use client";
// Restore form (A152, A157). Submitting asks for a second Admin's approval (a Super Admin's is
// immediate).
import {
  RESTORE_SCOPE_LABELS,
  type RestoreScope,
  type RestoreSource,
  type RestoreTarget,
} from "@ulixops/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatBytes } from "@/lib/backups";
import { formatUtc } from "@/lib/format";
import { startRestoreAction } from "./actions";

const SCOPES: { value: RestoreScope; help: string; across: string }[] = [
  {
    value: "ALL",
    help: "The database and every file go back to the backup. Files added since then stay; wp-config.php is kept as it is now.",
    across:
      "A full copy of that backup. The database, plugins, themes and uploads that exist only here are removed. This environment's domain and wp-config.php stay.",
  },
  {
    value: "DATABASE",
    help: "Posts, pages, orders, settings and users go back to the backup. Files aren't touched. The quickest fix after a bad import or a broken setting.",
    across:
      "The database is replaced with the backup (tables that exist only here are removed). Files stay. The site address becomes this environment's domain.",
  },
  {
    value: "FILES",
    help: "Plugins, themes and uploads (wp-content) go back to the backup. The database isn't touched.",
    across:
      "Plugins, themes and uploads are replaced with the backup (folders that exist only here are removed). The database isn't touched.",
  },
];

const OVERWRITES: Record<RestoreScope, string> = {
  ALL: "The database and files",
  DATABASE: "The database",
  FILES: "wp-content (plugins, themes and uploads)",
};

const ENV_NAME = { PRODUCTION: "production", STAGING: "staging" } as const;
const ENV_TITLE = { PRODUCTION: "Production", STAGING: "Staging" } as const;

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function sourceLabel(s: RestoreSource): string {
  const when = formatUtc(s.at);
  const env = s.environment === "STAGING" ? "Staging" : "Production";
  return s.purpose === "SAFETY"
    ? `${env} · safety copy before a restore, ${when} (${formatBytes(s.bytes)})`
    : `${env} · weekly backup, ${when} (${formatBytes(s.bytes)})`;
}

/**
 * Restore form (A152, A157): site → environment to overwrite → a backup of either environment
 * of that site → what to restore → type the site's name. A backup of the other environment is
 * copied across and the site address inside the database is changed to the target's.
 */
export function RestoreForm({
  sources,
  targets,
  preselect,
}: {
  sources: RestoreSource[];
  targets: RestoreTarget[];
  preselect: string | null;
}) {
  const sites = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of sources) if (!seen.has(s.siteId)) seen.set(s.siteId, s.siteName);
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [sources]);
  const initial = sources.find((s) => s.backupId === preselect) ?? null;
  const [siteId, setSiteId] = useState(initial?.siteId ?? "");
  const [target, setTarget] = useState<RestoreTarget["environment"]>(
    initial?.environment ?? "PRODUCTION",
  );
  const [backupId, setBackupId] = useState(initial?.backupId ?? "");
  const [scope, setScope] = useState<RestoreScope>("DATABASE");
  const [typed, setTyped] = useState("");

  const envs = targets.filter((t) => t.siteId === siteId);
  const into = envs.find((t) => t.environment === target) ?? null;
  // The target's own backups first, then the other environment's.
  const options = sources
    .filter((s) => s.siteId === siteId)
    .sort((a, b) => Number(b.environment === target) - Number(a.environment === target));
  const chosen = options.find((s) => s.backupId === backupId) ?? null;
  const from = chosen ? envs.find((t) => t.environment === chosen.environment) : undefined;
  const across = chosen !== null && chosen.environment !== target;
  const siteName = chosen?.siteName ?? "";
  const ready =
    chosen !== null &&
    into?.ready === true &&
    typed.trim().toLowerCase() === siteName.toLowerCase();

  const pickSite = (id: string) => {
    setSiteId(id);
    setTarget("PRODUCTION");
    const first = sources.find((s) => s.siteId === id && s.environment === "PRODUCTION");
    setBackupId((first ?? sources.find((s) => s.siteId === id))?.backupId ?? "");
    setTyped("");
  };
  const pickBackup = (id: string) => {
    setBackupId(id);
    const next = sources.find((s) => s.backupId === id);
    if (next && next.environment !== target) setScope("ALL");
  };
  const pickTarget = (env: RestoreTarget["environment"]) => {
    setTarget(env);
    const own = sources.find((s) => s.siteId === siteId && s.environment === env);
    if (own) setBackupId(own.backupId);
    else setScope("ALL");
  };

  return (
    <ActionForm
      action={startRestoreAction}
      submitLabel="Request restore"
      variant="destructive"
      pendingLabel="Requesting…"
      confirm={
        ready && chosen
          ? {
              title: `Restore ${siteName} (${ENV_NAME[target]})?`,
              description: `${OVERWRITES[scope]} of ${ENV_NAME[target]} will be overwritten with the ${across ? `${ENV_NAME[chosen.environment]} ` : ""}backup of ${formatUtc(chosen.at)}.${across && scope !== "FILES" ? ` The site address becomes ${host(into?.url ?? "")}, this environment's domain. The previous database is removed first.` : ""}${across && scope !== "DATABASE" ? ` Plugins, themes and uploads that exist only on ${ENV_NAME[target]} are removed.` : ""} wp-config.php stays. A safety copy of ${ENV_NAME[target]} as it is now is saved first and kept 7 days, so you can undo it. Another Admin must approve before anything happens.`,
            }
          : undefined
      }
    >
      <input type="hidden" name="target" value={target} />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="restore-site">Site</Label>
          <Select id="restore-site" value={siteId} onChange={(e) => pickSite(e.target.value)}>
            <option value="">Choose a site…</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="restore-target">Restore to</Label>
          <Select
            id="restore-target"
            value={target}
            disabled={!siteId}
            onChange={(e) => pickTarget(e.target.value === "STAGING" ? "STAGING" : "PRODUCTION")}
          >
            {envs.map((t) => (
              <option key={t.environment} value={t.environment} disabled={!t.ready}>
                {t.environment === "STAGING" ? "Staging" : "Production"} · {host(t.url)}
                {t.ready ? "" : " (connection not tested)"}
              </option>
            ))}
            {!siteId && <option value="PRODUCTION">Choose a site first</option>}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="restore-backup">Backup on Google Drive</Label>
          <Select
            id="restore-backup"
            name="backupId"
            value={backupId}
            disabled={!siteId}
            onChange={(e) => pickBackup(e.target.value)}
          >
            {!siteId && <option value="">Choose a site first</option>}
            {options.map((s) => (
              <option key={s.backupId} value={s.backupId}>
                {sourceLabel(s)}
              </option>
            ))}
          </Select>
          {chosen?.webViewLink && (
            <a
              href={chosen.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-link hover:underline"
            >
              Open in Drive
            </a>
          )}
        </div>
      </div>

      {siteId && !options.some((s) => s.environment === target) && (
        <p className="text-sm text-muted-foreground">
          {target === "STAGING" ? "Staging" : "Production"} has no backup of its own yet; you can
          copy the other environment&apos;s into it, or back it up first on{" "}
          <Link href="/backups/full" className="text-link hover:underline">
            Full backups
          </Link>
          .
        </p>
      )}
      {across && chosen && (
        <div
          role="status"
          className="grid gap-1 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
        >
          <span className="font-medium">
            {ENV_TITLE[chosen.environment]} → {ENV_TITLE[target]}
          </span>
          <span className="text-muted-foreground">
            {scope === "FILES"
              ? `Plugins, themes and uploads on ${ENV_NAME[target]} are replaced with this backup. Folders that exist only here are removed. The database and its addresses aren't touched. wp-config.php stays.`
              : scope === "ALL"
                ? `A full copy of that backup onto ${ENV_NAME[target]}. Only the domain stays ${host(into?.url ?? "")} (addresses change from ${host(from?.url ?? "")}). The previous database, plugins, themes and uploads are removed first. wp-config.php stays. Both environments must use the same table prefix (checked first).`
                : `The database on ${ENV_NAME[target]} is replaced with this backup. The site address becomes ${host(into?.url ?? "")}. Tables that exist only here are removed. Files and wp-config.php stay. Both environments must use the same table prefix (checked first).`}
            {target === "PRODUCTION" &&
              " This replaces the live site: orders, form entries and posts added on production since are lost."}
          </span>
        </div>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">What to restore</legend>
        {SCOPES.map((s) => (
          <label
            key={s.value}
            className="flex items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name="scope"
              value={s.value}
              checked={scope === s.value}
              onChange={() => setScope(s.value)}
              className="mt-1 size-4"
            />
            <span className="grid gap-0.5">
              <span className="font-medium">{RESTORE_SCOPE_LABELS[s.value]}</span>
              <span className="text-xs text-muted-foreground">{across ? s.across : s.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor="restore-confirm">
          Type the site&apos;s name{chosen ? ` (${siteName})` : ""} to confirm
        </Label>
        <Input
          id="restore-confirm"
          name="confirmName"
          autoComplete="off"
          value={typed}
          disabled={!chosen || !into?.ready}
          onChange={(e) => setTyped(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          The site shows its maintenance page while it&apos;s restored, and gets a health check
          afterwards.
        </p>
      </div>
    </ActionForm>
  );
}
