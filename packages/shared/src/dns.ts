// Cloudflare DNS management (Phase 3 step 3, A156): zones, records, snapshots + rollback,
// change alerts, migration checklist, cache purge. One owner-created API token (Zone Read, DNS
// Edit, Cache Purge) covers every zone the Ulix Digital Cloudflare login can see; it lives in
// the vault and only the runner uses it.
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();

/** Vault name of the Cloudflare API token (a name, never the token). */
export const CLOUDFLARE_TOKEN_REF = "CLOUDFLARE_API_TOKEN";

/** Cloudflare zone and record ids: 32 hex characters. */
export const CfId = z.string().regex(/^[a-f0-9]{32}$/);

/** Record types UlixOps can add, edit, delete and roll back. Others are shown read-only. */
export const MANAGED_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX"] as const;
export const ManagedRecordType = z.enum(MANAGED_RECORD_TYPES);
export type ManagedRecordType = z.infer<typeof ManagedRecordType>;
export const PROXIABLE_TYPES: readonly string[] = ["A", "AAAA", "CNAME"];

/** Zones per hub, records per zone and changes per job, so nothing grows without bound. */
export const MAX_DNS_ZONES = 200;
export const MAX_DNS_RECORDS = 3000;
export const MAX_DNS_CHANGES = 300;
export const MAX_PURGE_URLS = 30;

const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
  );
export const ZoneName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  .max(253);

/** TTL: 1 = automatic, otherwise 60 s to 1 day. */
const Ttl = z.union([z.literal(1), z.number().int().min(60).max(86_400)]);

/** A record as Cloudflare stores it (what snapshots keep and the runner returns). */
export const DnsRecord = z.object({
  id: CfId,
  type: z.string().regex(/^[A-Z0-9]{1,12}$/),
  name: z.string().max(253),
  content: z.string().max(4096),
  ttl: z.number().int(),
  proxied: z.boolean(),
  priority: z.number().int().min(0).max(65_535).nullable(),
  comment: z.string().max(500).nullable(),
});
export type DnsRecord = z.infer<typeof DnsRecord>;

/** What a new or edited record will be (managed types only), with the name fully qualified. */
export const DnsRecordValue = z
  .object({
    type: ManagedRecordType,
    name: Hostname,
    content: z.string().trim().min(1).max(2048),
    ttl: Ttl,
    proxied: z.boolean(),
    priority: z.number().int().min(0).max(65_535).nullable(),
    comment: z.string().trim().max(100).nullable(),
  })
  .superRefine((r, ctx) => {
    const bad = (message: string, path: string) =>
      ctx.addIssue({ code: "custom", message, path: [path] });
    if (r.type === "A" && !z.ipv4().safeParse(r.content).success)
      bad("Enter an IPv4 address", "content");
    if (r.type === "AAAA" && !z.ipv6().safeParse(r.content).success)
      bad("Enter an IPv6 address", "content");
    if ((r.type === "CNAME" || r.type === "MX") && !Hostname.safeParse(r.content).success)
      bad("Enter a host name, like example.com", "content");
    // Printable text only: no control characters or line breaks.
    if (r.type === "TXT" && !/^[\x20-\x7e]+$/.test(r.content))
      bad("Use plain text without line breaks", "content");
    if (r.type === "MX" && r.priority === null) bad("MX records need a priority", "priority");
    if (r.type !== "MX" && r.priority !== null) bad("Only MX records have a priority", "priority");
    if (r.proxied && !PROXIABLE_TYPES.includes(r.type))
      bad("Only A, AAAA and CNAME can be proxied", "proxied");
  });
export type DnsRecordValue = z.infer<typeof DnsRecordValue>;

/**
 * "@" → the zone, "www" → www.zone, a full name inside the zone stays. Like Cloudflare, other
 * names are relative to the zone; a trailing dot makes a name absolute, and null means that
 * absolute name is outside the zone.
 */
export function fullRecordName(input: string, zone: string): string | null {
  const raw = input.trim().toLowerCase();
  const absolute = raw.endsWith(".") && raw !== ".";
  const name = raw.replace(/\.$/, "");
  const z0 = zone.toLowerCase();
  if (name === "" || name === "@") return z0;
  if (name === z0 || name.endsWith(`.${z0}`)) return name;
  return absolute ? null : `${name}.${z0}`;
}

/** The record's name without the zone ("@" for the zone itself), for display. */
export function shortRecordName(name: string, zone: string): string {
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
}

// ---- Runner jobs ---------------------------------------------------------------------------

export const DnsChangeOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), record: DnsRecordValue }),
  z.object({ op: z.literal("update"), id: CfId, record: DnsRecordValue }),
  z.object({ op: z.literal("delete"), id: CfId }),
]);
export type DnsChangeOp = z.infer<typeof DnsChangeOp>;

export const CfZone = z.object({
  id: CfId,
  name: ZoneName,
  status: z.string().max(40),
  paused: z.boolean(),
  accountName: z.string().max(200).nullable(),
  plan: z.string().max(100).nullable(),
  nameServers: z.array(z.string().max(253)).max(20),
  originalNameServers: z.array(z.string().max(253)).max(20),
  originalRegistrar: z.string().max(200).nullable(),
});
export type CfZone = z.infer<typeof CfZone>;

/** Why Cloudflare said no, in plain words (never the token). */
const CfProblem = z.object({ ok: z.literal(false), error: z.string().max(500) });

export const DnsZonesResult = z.union([
  z.object({ ok: z.literal(true), zones: z.array(CfZone).max(MAX_DNS_ZONES) }),
  CfProblem,
]);
export type DnsZonesResult = z.infer<typeof DnsZonesResult>;

export const DnsRecordsResult = z.union([
  z.object({ ok: z.literal(true), records: z.array(DnsRecord).max(MAX_DNS_RECORDS) }),
  CfProblem,
]);
export type DnsRecordsResult = z.infer<typeof DnsRecordsResult>;

/** Each change in order; the job stops at the first failure (the rest are not tried). */
export const DnsApplyResult = z.object({
  applied: z.number().int().nonnegative(),
  failed: z.object({ index: z.number().int(), error: z.string().max(500) }).nullable(),
});
export type DnsApplyResult = z.infer<typeof DnsApplyResult>;

export const DnsPurgeResult = z.union([z.object({ ok: z.literal(true) }), CfProblem]);
export type DnsPurgeResult = z.infer<typeof DnsPurgeResult>;

// ---- Snapshots and rollback ----------------------------------------------------------------

const keyOf = (r: { type: string; name: string; content: string }) =>
  `${r.type}|${r.name.toLowerCase()}|${r.content}`;

const valueOf = (r: DnsRecord): DnsRecordValue => ({
  type: r.type as ManagedRecordType,
  name: r.name.toLowerCase(),
  content: r.content,
  ttl: r.ttl,
  proxied: r.proxied,
  priority: r.type === "MX" ? r.priority : null,
  comment: r.comment,
});

const managed = (r: DnsRecord) => (MANAGED_RECORD_TYPES as readonly string[]).includes(r.type);

/**
 * The changes that turn `current` into `target` for managed record types (others are never
 * touched). Records match on type + name + content; a match with a different TTL, proxy or
 * priority is an update.
 */
export function planRollback(current: DnsRecord[], target: DnsRecord[]): DnsChangeOp[] {
  const now = new Map(current.filter(managed).map((r) => [keyOf(r), r]));
  const want = new Map(target.filter(managed).map((r) => [keyOf(r), r]));
  const ops: DnsChangeOp[] = [];
  for (const [key, r] of now) if (!want.has(key)) ops.push({ op: "delete", id: r.id });
  for (const [key, w] of want) {
    const r = now.get(key);
    if (!r) ops.push({ op: "create", record: valueOf(w) });
    else if (
      r.ttl !== w.ttl ||
      r.proxied !== w.proxied ||
      (r.priority ?? null) !== (w.priority ?? null)
    )
      ops.push({ op: "update", id: r.id, record: valueOf(w) });
  }
  return ops;
}

/** Added / removed / changed records between two snapshots, for change alerts and history. */
export function diffRecords(before: DnsRecord[], after: DnsRecord[]) {
  const was = new Map(before.map((r) => [keyOf(r), r]));
  const is = new Map(after.map((r) => [keyOf(r), r]));
  const added = after.filter((r) => !was.has(keyOf(r)));
  const removed = before.filter((r) => !is.has(keyOf(r)));
  const changed = after.filter((r) => {
    const w = was.get(keyOf(r));
    return w && (w.ttl !== r.ttl || w.proxied !== r.proxied || w.priority !== r.priority);
  });
  return { added, removed, changed };
}

/** One line per difference: "+ A www.example.com → 1.2.3.4". */
export function describeDiff(d: ReturnType<typeof diffRecords>, max = 10): string[] {
  const line = (sign: string, r: DnsRecord) =>
    `${sign} ${r.type} ${r.name} → ${r.content}`.slice(0, 200);
  const lines = [
    ...d.added.map((r) => line("+", r)),
    ...d.removed.map((r) => line("−", r)),
    ...d.changed.map(
      (r) =>
        `${line("~", r)} (TTL ${r.ttl === 1 ? "auto" : r.ttl}, ${r.proxied ? "proxied" : "DNS only"})`,
    ),
  ];
  return lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more`] : lines;
}

/** Stable fingerprint of a record set (order doesn't matter). */
export function recordsFingerprint(records: DnsRecord[]): string {
  return records
    .map((r) => `${keyOf(r)}|${r.ttl}|${r.proxied ? 1 : 0}|${r.priority ?? ""}`)
    .sort()
    .join("\n");
}

// ---- Migration checklist -------------------------------------------------------------------

/** Steps moving a domain onto Cloudflare; `auto` ones are worked out from Cloudflare's data. */
export const MIGRATION_STEPS = [
  {
    key: "records_copied",
    label: "All records copied from the old DNS host (compare with the old zone file)",
    auto: false,
  },
  {
    key: "email_records",
    label: "Email records checked: MX, SPF, DKIM and DMARC TXT",
    auto: false,
  },
  { key: "nameservers", label: "Nameservers at the registrar point to Cloudflare", auto: true },
  { key: "zone_active", label: "Zone is active in Cloudflare", auto: true },
  {
    key: "host_domain",
    label: "Domain added on the web host (WP Engine: Domains) and its SSL issued",
    auto: false,
  },
  { key: "ssl_mode", label: "Cloudflare SSL/TLS mode set to Full (strict)", auto: false },
  {
    key: "site_https",
    label: "Site loads over HTTPS on the new DNS (check uptime / SSL in Monitoring)",
    auto: false,
  },
  { key: "old_dns_kept", label: "Old DNS host kept for 48 hours, then closed", auto: false },
] as const;
export type MigrationStepKey = (typeof MIGRATION_STEPS)[number]["key"];
export const MigrationStepKey = z.enum(
  MIGRATION_STEPS.map((s) => s.key) as [MigrationStepKey, ...MigrationStepKey[]],
);

export const SetChecklistItem = z.object({ key: MigrationStepKey, done: z.boolean() });

// ---- API requests and views ----------------------------------------------------------------

export const DnsRecordInput = z.object({
  type: ManagedRecordType,
  /** "@", "www", or a full name inside the zone. */
  name: z.string().trim().min(1).max(253),
  content: z.string().trim().min(1).max(2048),
  ttl: Ttl,
  proxied: z.boolean(),
  priority: z.number().int().min(0).max(65_535).nullable(),
  comment: z.string().trim().max(100).nullable(),
});
export type DnsRecordInput = z.infer<typeof DnsRecordInput>;

export const PurgeRequest = z.discriminatedUnion("everything", [
  z.object({ everything: z.literal(true) }),
  z.object({
    everything: z.literal(false),
    urls: z
      .array(z.url({ protocol: /^https?$/ }).max(2000))
      .min(1)
      .max(MAX_PURGE_URLS),
  }),
]);
export type PurgeRequest = z.infer<typeof PurgeRequest>;

export const DnsZoneView = z.object({
  id: CfId,
  name: z.string(),
  status: z.string(),
  paused: z.boolean(),
  accountName: z.string().nullable(),
  plan: z.string().nullable(),
  nameServers: z.array(z.string()),
  originalNameServers: z.array(z.string()),
  recordCount: z.number().int(),
  site: z.object({ id, name: z.string() }).nullable(),
  lastSyncAt: iso.nullable(),
  lastChangeAt: iso.nullable(),
  /** Changes made outside UlixOps in the last 7 days. */
  externalChanges7d: z.number().int(),
  removed: z.boolean(),
});
export type DnsZoneView = z.infer<typeof DnsZoneView>;

export const DnsSyncStatus = z.object({
  running: z.boolean(),
  lastRunAt: iso.nullable(),
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type DnsSyncStatus = z.infer<typeof DnsSyncStatus>;

export const DnsOverview = z.object({
  tokenSet: z.boolean(),
  status: DnsSyncStatus,
  zones: z.array(DnsZoneView),
});
export type DnsOverview = z.infer<typeof DnsOverview>;

export const DnsChangeKind = z.enum([
  "create",
  "update",
  "delete",
  "rollback",
  "purge",
  "external",
]);
export type DnsChangeKind = z.infer<typeof DnsChangeKind>;

export const DnsChangeView = z.object({
  id,
  kind: DnsChangeKind,
  at: iso,
  by: z.string().nullable(),
  summary: z.string(),
  lines: z.array(z.string()),
  ok: z.boolean(),
});
export type DnsChangeView = z.infer<typeof DnsChangeView>;

export const DnsSnapshotView = z.object({
  id,
  takenAt: iso,
  reason: z.string(),
  recordCount: z.number().int(),
  /** Records that differ from the zone now (managed types), 0 = same as now. */
  differences: z.number().int(),
});
export type DnsSnapshotView = z.infer<typeof DnsSnapshotView>;

export const DnsZoneDetail = z.object({
  zone: DnsZoneView,
  records: z.array(DnsRecord),
  changes: z.array(DnsChangeView),
  snapshots: z.array(DnsSnapshotView),
  checklist: z.array(
    z.object({ key: MigrationStepKey, label: z.string(), auto: z.boolean(), done: z.boolean() }),
  ),
  /** An open rollback request for this zone. */
  pendingRollback: z.object({ requestId: id, snapshotId: id }).nullable(),
});
export type DnsZoneDetail = z.infer<typeof DnsZoneDetail>;
