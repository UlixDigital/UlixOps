// Risky actions that wait for a second Admin (spec section 5). Each one says what it changes,
// and applies only if the site is still in the state the request was made against.
import {
  ApiKeyName,
  autoUpdateWindowStart,
  AutoUpdateWindow,
  CredentialRef,
  EnvKind,
  HostKeyFingerprint,
  RecordId,
  RESTORE_SCOPE_LABELS,
  RestoreScope,
  SshHost,
  WEEKDAYS,
} from "@ulixops/shared";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";

type Tx = Prisma.TransactionClient;

const Connection = z.object({
  sshHost: SshHost,
  sshPort: z.number().int(),
  sshUser: z.string(),
  credentialRef: CredentialRef,
});

const ENV_LABEL = { PRODUCTION: "production", STAGING: "staging" } as const;

const ConnectionChange = z.object({
  siteId: z.string(),
  kind: EnvKind,
  from: Connection,
  to: Connection,
});
const HostKeyReset = z.object({ siteId: z.string(), kind: EnvKind, hostKey: HostKeyFingerprint });

const DeployBulk = z.object({
  /** First target site — used by the Approvals list for a name (agent decision A82). */
  siteId: RecordId,
  deploymentId: RecordId,
  pluginSlug: z.string(),
  version: z.string(),
  siteIds: z.array(RecordId).min(2).max(100),
  siteCount: z.number().int().min(2),
});

const SiteArchive = z.object({
  siteId: z.string(),
  kind: z.literal("PRODUCTION"),
  name: z.string(),
});

const BulkUpdateItem = z.object({
  asset: z.enum(["plugin", "theme"]),
  name: z.string().min(1).max(100),
  version: z.string().max(50),
  updateVersion: z.string().max(50),
  safety: z.enum(["patch", "minor", "major", "unknown"]).optional(),
});

const SiteBulkUpdate = z.object({
  siteId: z.string(),
  kind: EnvKind,
  strategy: z.literal("snapshots"),
  items: z.array(BulkUpdateItem).min(2).max(200),
});

/** Restore a full backup from Google Drive over the site (A152). */
const BackupRestore = z.object({
  siteId: RecordId,
  kind: EnvKind,
  restoreId: RecordId,
  backupId: RecordId,
  /** When the backup was taken, for the description. */
  backupAt: z.iso.datetime(),
  scope: RestoreScope,
  /** Set when the backup is the other environment's (A157). */
  from: EnvKind.optional(),
});

/** Switch PHP error logging on for several sites at once (A160): a bulk config change. */
/** Switch scheduled updates on (A162): one site (kind "autoupdate") or many ("bulk"). */
const AutoUpdateEnable = z.object({
  siteId: z.string(),
  kind: z.enum(["autoupdate", "bulk"]),
  siteIds: z.array(RecordId).min(1).max(200),
  siteNames: z.array(z.string().max(200)).max(200),
  sites: z
    .array(AutoUpdateWindow.extend({ siteId: RecordId }))
    .min(1)
    .max(200),
});

const DebugLogBulk = z.object({
  siteId: z.literal(""),
  kind: z.literal("bulk"),
  environmentIds: z.array(RecordId).min(1).max(200),
  siteNames: z.array(z.string().max(200)).max(200),
});

/** Roll a Cloudflare zone back to a snapshot (A156): many record changes at once. */
const DnsRollbackPayload = z.object({
  siteId: z.literal(""),
  /** The zone id (also the duplicate-request key). */
  kind: z.string().regex(/^[a-f0-9]{32}$/),
  zone: z.string().max(253),
  rollbackId: RecordId,
  snapshotId: RecordId,
  takenAt: z.iso.datetime(),
});

/**
 * Set or replace an integration API key (A133). Hub-wide, so siteId is empty. Approving it
 * changes nothing yet: the requester then has API_KEY_WINDOW_MS to enter the key once.
 */
const ApiKeySet = z.object({
  siteId: z.literal(""),
  kind: ApiKeyName,
  /** Set when the key was entered; the approval can't be used again. */
  usedAt: z.iso.datetime().optional(),
});

const API_KEY_LABELS = {
  WORDFENCE_API_KEY: "Wordfence Intelligence API key",
  GOOGLE_DRIVE_CLIENT_ID: "Google Drive client ID",
  GOOGLE_DRIVE_CLIENT_SECRET: "Google Drive client secret",
  BACKUP_ENCRYPTION_KEY: "backup encryption key",
  CLOUDFLARE_API_TOKEN: "Cloudflare API token",
} as const;

/** Wraps an action so callers pass raw payloads; each action validates its own shape. */
function defineAction<P extends { siteId: string }>(definition: {
  payload: z.ZodType<P>;
  describe: (payload: P, siteName: string) => string;
  apply: (tx: Tx, payload: P) => Promise<boolean>;
}) {
  return {
    payload: definition.payload,
    siteIdOf: (raw: unknown) => definition.payload.safeParse(raw).data?.siteId ?? null,
    describe(raw: unknown, siteName: string) {
      const parsed = definition.payload.safeParse(raw);
      return parsed.success ? definition.describe(parsed.data, siteName) : null;
    },
    apply: (tx: Tx, raw: unknown) => definition.apply(tx, definition.payload.parse(raw)),
  };
}

export const APPROVAL_ACTIONS = {
  /** New SSH key, host, port or user for an environment (agent decision A47). */
  "site.connection.change": defineAction({
    payload: ConnectionChange,
    describe(p: z.infer<typeof ConnectionChange>, siteName: string) {
      const parts: string[] = [];
      if (p.from.credentialRef !== p.to.credentialRef)
        parts.push(`SSH key ${p.from.credentialRef} → ${p.to.credentialRef}`);
      if (p.from.sshHost !== p.to.sshHost || p.from.sshPort !== p.to.sshPort) {
        parts.push(`server ${p.from.sshHost}:${p.from.sshPort} → ${p.to.sshHost}:${p.to.sshPort}`);
      }
      if (p.from.sshUser !== p.to.sshUser) parts.push(`user ${p.from.sshUser} → ${p.to.sshUser}`);
      return `${siteName} (${ENV_LABEL[p.kind]}): ${parts.join(", ")}`;
    },
    async apply(tx: Tx, p: z.infer<typeof ConnectionChange>) {
      const serverChanged = p.from.sshHost !== p.to.sshHost || p.from.sshPort !== p.to.sshPort;
      const result = await tx.siteEnvironment.updateMany({
        where: { siteId: p.siteId, kind: p.kind, ...p.from },
        data: { ...p.to, lastTestOk: null, ...(serverChanged ? { hostKey: null } : {}) },
      });
      return result.count === 1;
    },
  }),
  /** Forget a pinned host key so the next test pins the server's current one. */
  "site.hostkey.reset": defineAction({
    payload: HostKeyReset,
    describe(p: z.infer<typeof HostKeyReset>, siteName: string) {
      return `${siteName} (${ENV_LABEL[p.kind]}): forget pinned host key ${p.hostKey}`;
    },
    async apply(tx: Tx, p: z.infer<typeof HostKeyReset>) {
      const result = await tx.siteEnvironment.updateMany({
        where: { siteId: p.siteId, kind: p.kind, hostKey: p.hostKey },
        data: { hostKey: null, lastTestOk: null },
      });
      return result.count === 1;
    },
  }),
  /** Bulk / all-sites production deploy (spec §6.4, agent decision A82). */
  "deploy.bulk": defineAction({
    payload: DeployBulk,
    describe(p: z.infer<typeof DeployBulk>, siteName: string) {
      return `Deploy ${p.pluginSlug} ${p.version} to ${p.siteCount} production sites (incl. ${siteName})`;
    },
    async apply(tx: Tx, p: z.infer<typeof DeployBulk>) {
      const result = await tx.deployment.updateMany({
        where: { id: p.deploymentId, status: "PENDING_APPROVAL", approvalId: { not: null } },
        data: { status: "QUEUED" },
      });
      return result.count === 1;
    },
  }),
  /**
   * Archive a site (Phase 1 stand-in for site.delete — SPEC §5 risky action, A91).
   * Payload keeps `kind` so requestApproval's uniqueness key matches other site actions.
   */
  "site.archive": defineAction({
    payload: SiteArchive,
    describe(_p: z.infer<typeof SiteArchive>, siteName: string) {
      return `Archive site ${siteName}`;
    },
    async apply(tx: Tx, p: z.infer<typeof SiteArchive>) {
      const result = await tx.site.updateMany({
        where: { id: p.siteId, archived: false },
        data: { archived: true },
      });
      return result.count === 1;
    },
  }),
  /** Production bulk plugin/theme update (A104). apply only verifies the site is still live. */
  "site.bulk_update": defineAction({
    payload: SiteBulkUpdate,
    describe(p: z.infer<typeof SiteBulkUpdate>, siteName: string) {
      const plugins = p.items.filter((i) => i.asset === "plugin").length;
      const themes = p.items.filter((i) => i.asset === "theme").length;
      const parts = [
        plugins ? `${plugins} plugin${plugins === 1 ? "" : "s"}` : null,
        themes ? `${themes} theme${themes === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      return `${siteName} (${ENV_LABEL[p.kind]}): update ${parts.join(" and ")}`;
    },
    async apply(tx: Tx, p: z.infer<typeof SiteBulkUpdate>) {
      const site = await tx.site.findFirst({
        where: { id: p.siteId, archived: false },
        include: { environments: { where: { kind: p.kind } } },
      });
      return Boolean(site?.environments[0]?.hostKey);
    },
  }),
  /** Restore from Google Drive (A152): apply queues it, if the backup is still on Drive. */
  "site.backup.restore": defineAction({
    payload: BackupRestore,
    describe(p: z.infer<typeof BackupRestore>, siteName: string) {
      const of = p.from
        ? `the ${ENV_LABEL[p.from].toLowerCase()} Google Drive backup`
        : "the Google Drive backup";
      const moved = !p.from
        ? ""
        : p.scope === "ALL"
          ? ", a full copy with this environment's site address (previous content removed)"
          : p.scope === "FILES"
            ? ", replacing plugins, themes and uploads"
            : ", changing the site address to this environment's";
      return `${siteName} (${ENV_LABEL[p.kind]}): restore ${RESTORE_SCOPE_LABELS[p.scope].toLowerCase()} from ${of} of ${p.backupAt.slice(0, 16).replace("T", " ")} UTC${moved}, after a safety copy`;
    },
    async apply(tx: Tx, p: z.infer<typeof BackupRestore>) {
      const result = await tx.fullRestore.updateMany({
        where: {
          id: p.restoreId,
          status: "PENDING_APPROVAL",
          source: { status: "READY" },
          environment: { site: { archived: false } },
        },
        data: { status: "QUEUED" },
      });
      return result.count === 1;
    },
  }),
  "site.debuglog.bulk": defineAction({
    payload: DebugLogBulk,
    describe(p: z.infer<typeof DebugLogBulk>) {
      const names = p.siteNames.slice(0, 5).join(", ");
      const more = p.siteNames.length > 5 ? ` and ${p.siteNames.length - 5} more` : "";
      return `Switch PHP error logging on (WP_DEBUG + WP_DEBUG_LOG, never shown on pages) for ${p.environmentIds.length} site${p.environmentIds.length === 1 ? "" : "s"}: ${names}${more}`;
    },
    // Nothing to claim: the switch runs after the decision and checks each site itself.
    async apply() {
      return true;
    },
  }),
  "site.autoupdate.enable": defineAction({
    payload: AutoUpdateEnable,
    describe(p: z.infer<typeof AutoUpdateEnable>) {
      const names = p.siteNames.slice(0, 5).join(", ");
      const more = p.siteNames.length > 5 ? ` and ${p.siteNames.length - 5} more` : "";
      const windows = [
        ...new Set(
          p.sites.map(
            (s) => `${WEEKDAYS[s.dayOfWeek] ?? "?"} ${String(s.hourUtc).padStart(2, "0")}:00 UTC`,
          ),
        ),
      ];
      return `Switch scheduled updates on (patch and minor plugin/theme updates and WordPress maintenance releases, installed unattended with snapshot, health check and rollback) for ${p.siteIds.length} site${p.siteIds.length === 1 ? "" : "s"}: ${names}${more}. Weekly window: ${windows.slice(0, 3).join(", ")}${windows.length > 3 ? ", …" : ""}`;
    },
    // Switches the schedules on in the decision's transaction; the first run is the next window.
    async apply(tx: Tx, p: z.infer<typeof AutoUpdateEnable>) {
      const at = new Date();
      let on = 0;
      for (const s of p.sites) {
        const live = await tx.site.findFirst({
          where: { id: s.siteId, archived: false },
          select: { id: true },
        });
        if (!live) continue;
        const data = {
          enabled: true,
          dayOfWeek: s.dayOfWeek,
          hourUtc: s.hourUtc,
          enabledAt: at,
          lastWindowAt: autoUpdateWindowStart(s, at),
        };
        await tx.autoUpdateSchedule.upsert({
          where: { siteId: s.siteId },
          create: { siteId: s.siteId, ...data },
          update: data,
        });
        on += 1;
      }
      return on > 0;
    },
  }),
  "dns.rollback": defineAction({
    payload: DnsRollbackPayload,
    describe(p: z.infer<typeof DnsRollbackPayload>) {
      return `${p.zone}: roll the DNS records back to the snapshot of ${p.takenAt.slice(0, 16).replace("T", " ")} UTC`;
    },
    async apply(tx: Tx, p: z.infer<typeof DnsRollbackPayload>) {
      const result = await tx.dnsRollback.updateMany({
        where: { id: p.rollbackId, status: "PENDING_APPROVAL", zone: { removedAt: null } },
        data: { status: "APPROVED" },
      });
      return result.count === 1;
    },
  }),
  "apikey.set": defineAction({
    payload: ApiKeySet,
    describe(p: z.infer<typeof ApiKeySet>) {
      return `Set the ${API_KEY_LABELS[p.kind]} (${p.kind}) in the vault`;
    },
    async apply() {
      return true;
    },
  }),
} as const;

export type ApprovalAction = keyof typeof APPROVAL_ACTIONS;

export function isApprovalAction(action: string): action is ApprovalAction {
  return action in APPROVAL_ACTIONS;
}
