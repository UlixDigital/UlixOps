// Risky actions that wait for a second Admin (spec section 5). Each one says what it changes,
// and applies only if the site is still in the state the request was made against.
import { CredentialRef, EnvKind, HostKeyFingerprint, RecordId, SshHost } from "@ulixops/shared";
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
} as const;

export type ApprovalAction = keyof typeof APPROVAL_ACTIONS;

export function isApprovalAction(action: string): action is ApprovalAction {
  return action in APPROVAL_ACTIONS;
}
