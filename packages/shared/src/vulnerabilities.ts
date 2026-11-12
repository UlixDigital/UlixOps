// Vulnerability scanning (Phase 2 step 2, A132). The runner streams the Wordfence Intelligence
// feed and keeps only records for software installed on our sites; the API stores them and
// matches each environment's inventory against them with the functions below.
import { z } from "zod";
import { CLOUDFLARE_TOKEN_REF } from "./dns";
import {
  BACKUP_KEY_REF,
  DRIVE_CLIENT_ID_REF,
  DRIVE_CLIENT_SECRET_REF,
  DRIVE_REFRESH_TOKEN_REF,
} from "./backups";

// ---- PHP version_compare (WordPress and Wordfence compare versions the PHP way) -------------

// Special forms in PHP order; any other word sorts below "dev". "#" stands for a number.
const SPECIAL_FORMS: [string, number][] = [
  ["dev", 0],
  ["alpha", 1],
  ["a", 1],
  ["beta", 2],
  ["b", 2],
  ["RC", 3],
  ["rc", 3],
  ["#", 4],
  ["pl", 5],
  ["p", 5],
];

function specialOrder(part: string): number {
  return SPECIAL_FORMS.find(([form]) => part.startsWith(form))?.[1] ?? -1;
}

/** PHP's canonical form: separators become ".", and digit/letter boundaries get one. */
function canonicalParts(version: string): string[] {
  return version
    .trim()
    .replace(/[-_+]/g, ".")
    .replace(/(\d)(?=[^\d.])|([^\d.])(?=\d)/g, "$1$2.")
    .split(".")
    .filter((part) => part !== "");
}

const isNumber = (part: string) => /^\d+$/.test(part);

function comparePart(a: string, b: string): number {
  if (isNumber(a) && isNumber(b)) return Math.sign(Number(a) - Number(b));
  const orderA = isNumber(a) ? specialOrder("#") : specialOrder(a);
  const orderB = isNumber(b) ? specialOrder("#") : specialOrder(b);
  return Math.sign(orderA - orderB);
}

/** -1, 0 or 1, like PHP's version_compare($a, $b). */
export function phpVersionCompare(a: string, b: string): number {
  const left = canonicalParts(a);
  const right = canonicalParts(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const result = comparePart(left[i] ?? "", right[i] ?? "");
    if (result !== 0) return result;
  }
  if (left.length === right.length) return 0;
  // One ran out: a trailing number makes the longer one newer; a trailing word ("rc", "beta")
  // is compared with a number, so 1.0rc1 < 1.0 < 1.0pl1.
  const rest = left.length > right.length ? (left[shared] ?? "") : (right[shared] ?? "");
  const sign = left.length > right.length ? 1 : -1;
  if (isNumber(rest)) return sign;
  return sign * comparePart(rest, "0");
}

// ---- Wordfence feed records ----------------------------------------------------------------

export const VULN_FEED_URL =
  "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production";

/** Vault secret holding the Wordfence Intelligence API key (a name, never the key). */
export const WORDFENCE_KEY_REF = "WORDFENCE_API_KEY";

/**
 * Integration keys kept in the vault next to the SSH keys, set from Settings → Credentials.
 * (The Wordfence CLI licence of A139 was dropped when Wordfence discontinued the CLI, A140.)
 */
export const API_KEY_NAMES = [
  WORDFENCE_KEY_REF,
  DRIVE_CLIENT_ID_REF,
  DRIVE_CLIENT_SECRET_REF,
  BACKUP_KEY_REF,
  CLOUDFLARE_TOKEN_REF,
] as const;

/** Secrets kept next to the SSH keys that are not SSH keys: hidden there and reserved. */
export const RESERVED_SECRET_NAMES: readonly string[] = [...API_KEY_NAMES, DRIVE_REFRESH_TOKEN_REF];

/** True for vault names that must never appear in the SSH-key credentials list (A182). */
export function isReservedVaultName(name: string): boolean {
  return RESERVED_SECRET_NAMES.includes(name) || name.startsWith("FILES_SFTP_");
}

export const SoftwareType = z.enum(["core", "plugin", "theme"]);
export type SoftwareType = z.infer<typeof SoftwareType>;

/** WordPress.org slugs: letters, digits, dot, dash and underscore. */
export const SoftwareSlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

const VersionText = z.string().trim().min(1).max(64);

/** One affected-versions range from the feed. "*" means no bound on that side. */
const RawRange = z.object({
  from_version: VersionText,
  from_inclusive: z.boolean(),
  to_version: VersionText,
  to_inclusive: z.boolean(),
});

const RawSoftware = z.object({
  type: z.string(),
  slug: z.string(),
  affected_versions: z.record(z.string(), RawRange),
  patched: z.boolean().optional(),
  patched_versions: z.array(z.string()).optional(),
});

/** The fields we use from one feed record; everything else is ignored. */
export const WordfenceRecord = z.object({
  id: z.string().regex(/^[0-9a-f-]{8,64}$/i),
  title: z.string().min(1),
  software: z.array(RawSoftware),
  informational: z.boolean().optional(),
  references: z.array(z.string()).optional(),
  published: z.string().nullish(),
  updated: z.string().nullish(),
  cve: z.string().nullish(),
  cvss: z.object({ score: z.number().nullish(), rating: z.string().nullish() }).nullish(),
});
export type WordfenceRecord = z.infer<typeof WordfenceRecord>;

export const Severity = z.enum(["critical", "high", "medium", "low", "unknown"]);
export type Severity = z.infer<typeof Severity>;

/** Worst first. */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "unknown"];

export const VersionRange = z.object({
  from: VersionText,
  fromInclusive: z.boolean(),
  to: VersionText,
  toInclusive: z.boolean(),
});
export type VersionRange = z.infer<typeof VersionRange>;

export const VulnSoftware = z.object({
  type: SoftwareType,
  slug: SoftwareSlug,
  ranges: z.array(VersionRange).max(50),
  patchedVersions: z.array(VersionText).max(50),
});
export type VulnSoftware = z.infer<typeof VulnSoftware>;

/** Compact record the runner returns and the API stores (one per Wordfence id). */
export const VulnRecord = z.object({
  id: z.string().regex(/^[0-9a-f-]{8,64}$/i),
  title: z.string().min(1).max(500),
  severity: Severity,
  cvssScore: z.number().min(0).max(10).nullable(),
  cve: z
    .string()
    .regex(/^CVE-\d{4}-\d{4,}$/)
    .nullable(),
  /** Wordfence's page for the record, when it has one. */
  reference: z
    .url({ protocol: /^https$/ })
    .max(500)
    .nullable(),
  publishedAt: z.iso.datetime().nullable(),
  software: z.array(VulnSoftware).min(1).max(20),
});
export type VulnRecord = z.infer<typeof VulnRecord>;

/** CVSS 3 bands, used when the feed gives a score but no rating. */
export function severityFromCvss(score: number | null | undefined): Severity {
  if (score == null) return "unknown";
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "unknown";
}

export const softwareKey = (type: SoftwareType, slug: string) => `${type}:${slug.toLowerCase()}`;

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Compact form of a feed record, keeping only software in `wanted` (softwareKey values).
 * Returns null for informational records, records about nothing we run, or bad data.
 */
export function toVulnRecord(raw: WordfenceRecord, wanted: ReadonlySet<string>): VulnRecord | null {
  if (raw.informational) return null;
  const software: VulnSoftware[] = [];
  for (const item of raw.software) {
    const type = SoftwareType.safeParse(item.type);
    const slug = SoftwareSlug.safeParse(item.slug);
    if (!type.success || !slug.success || !wanted.has(softwareKey(type.data, slug.data))) continue;
    software.push({
      type: type.data,
      slug: slug.data.toLowerCase(),
      ranges: Object.values(item.affected_versions)
        .slice(0, 50)
        .map((r) => ({
          from: r.from_version,
          fromInclusive: r.from_inclusive,
          to: r.to_version,
          toInclusive: r.to_inclusive,
        })),
      patchedVersions: (item.patched_versions ?? [])
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && v.length <= 64)
        .slice(0, 50),
    });
  }
  if (software.length === 0) return null;
  const rating = raw.cvss?.rating?.toLowerCase();
  const severity = Severity.safeParse(rating);
  const score = raw.cvss?.score;
  const reference =
    raw.references?.find((url) => url.startsWith("https://www.wordfence.com/")) ??
    raw.references?.find((url) => url.startsWith("https://")) ??
    null;
  const parsed = VulnRecord.safeParse({
    id: raw.id.toLowerCase(),
    title: raw.title.slice(0, 500),
    severity:
      severity.success && severity.data !== "unknown" ? severity.data : severityFromCvss(score),
    cvssScore: typeof score === "number" && score >= 0 && score <= 10 ? score : null,
    cve: raw.cve && /^CVE-\d{4}-\d{4,}$/.test(raw.cve) ? raw.cve : null,
    reference: reference && reference.length <= 500 ? reference : null,
    publishedAt: isoOrNull(raw.published),
    software: software.slice(0, 20),
  });
  return parsed.success ? parsed.data : null;
}

// ---- Matching ------------------------------------------------------------------------------

export function versionInRange(version: string, range: VersionRange): boolean {
  if (range.from !== "*") {
    const c = phpVersionCompare(range.from, version);
    if (!(c < 0 || (range.fromInclusive && c === 0))) return false;
  }
  if (range.to !== "*") {
    const c = phpVersionCompare(range.to, version);
    if (!(c > 0 || (range.toInclusive && c === 0))) return false;
  }
  return true;
}

export interface InstalledSoftware {
  type: SoftwareType;
  slug: string;
  version: string;
}

export interface VulnMatch {
  vulnerabilityId: string;
  type: SoftwareType;
  slug: string;
  installedVersion: string;
  /** Lowest patched version above the installed one, or null when no fix is known. */
  fixedIn: string | null;
}

/** Every (record, installed software) pair where the installed version is affected. */
export function matchVulnerabilities(
  installed: readonly InstalledSoftware[],
  records: readonly VulnRecord[],
): VulnMatch[] {
  const byKey = new Map<string, InstalledSoftware[]>();
  for (const item of installed) {
    if (!item.version) continue;
    const key = softwareKey(item.type, item.slug);
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  const matches: VulnMatch[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const software of record.software) {
      for (const item of byKey.get(softwareKey(software.type, software.slug)) ?? []) {
        if (!software.ranges.some((range) => versionInRange(item.version, range))) continue;
        const id = `${record.id}|${software.type}|${software.slug}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const fixes = software.patchedVersions
          .filter((v) => phpVersionCompare(v, item.version) > 0)
          .sort(phpVersionCompare);
        matches.push({
          vulnerabilityId: record.id,
          type: software.type,
          slug: software.slug,
          installedVersion: item.version,
          fixedIn: fixes[0] ?? null,
        });
      }
    }
  }
  return matches;
}

// ---- Runner job result ---------------------------------------------------------------------

export const MAX_WANTED_SOFTWARE = 5000;
export const MAX_VULN_RECORDS = 20_000;

export const WantedSoftware = z.object({ type: SoftwareType, slug: SoftwareSlug });

export const VulnFeedResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    fetchedAt: z.iso.datetime(),
    /** Records in the whole feed. */
    total: z.number().int().nonnegative(),
    records: z.array(VulnRecord).max(MAX_VULN_RECORDS),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["not_configured", "rejected", "unavailable", "invalid"]),
    detail: z.string().max(500),
  }),
]);
export type VulnFeedResult = z.infer<typeof VulnFeedResult>;

// ---- API views -----------------------------------------------------------------------------

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();

export const VulnFeedStatus = z.object({
  lastAttemptAt: iso.nullable(),
  lastSuccessAt: iso.nullable(),
  ok: z.boolean().nullable(),
  /** Why the last attempt failed, in plain words. */
  error: z.string().max(500).nullable(),
  /** Records kept (software we run) / records in the whole feed, at the last success. */
  records: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  running: z.boolean(),
});
export type VulnFeedStatus = z.infer<typeof VulnFeedStatus>;

export const VulnFindingView = z.object({
  id,
  siteId: id,
  siteName: z.string(),
  environment: z.enum(["PRODUCTION", "STAGING"]),
  type: SoftwareType,
  slug: z.string(),
  installedVersion: z.string(),
  fixedIn: z.string().nullable(),
  vulnerabilityId: z.string(),
  title: z.string(),
  severity: Severity,
  cvssScore: z.number().nullable(),
  cve: z.string().nullable(),
  reference: z.string().nullable(),
  firstSeenAt: iso,
  resolvedAt: iso.nullable(),
});
export type VulnFindingView = z.infer<typeof VulnFindingView>;

export const VulnFindingList = z.object({
  findings: z.array(VulnFindingView),
  feed: VulnFeedStatus,
});
export type VulnFindingList = z.infer<typeof VulnFindingList>;

/** Open findings per environment, for the sites list and dashboard. */
export const VulnSummary = z.object({
  open: z.number().int().nonnegative(),
  worst: Severity.nullable(),
});
export type VulnSummary = z.infer<typeof VulnSummary>;

/** Worst severity in a list (null for an empty list). */
export function worstSeverity(severities: readonly Severity[]): Severity | null {
  for (const level of SEVERITY_ORDER) if (severities.includes(level)) return level;
  return null;
}
