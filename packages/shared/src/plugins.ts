// Contracts for the custom plugin registry (Build Order step 7, spec 6.3, screens 6-8).
import { z } from "zod";
import { slug, version } from "./commands";
import { EnvKind } from "./sites";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Largest plugin ZIP UlixOps accepts (spec 5: size limit). Agent decision A62. */
export const MAX_PLUGIN_ZIP_BYTES = 10 * 1024 * 1024;
/** How long a checked upload waits for its changelog before it is discarded. */
export const PLUGIN_UPLOAD_TTL_MS = 60 * 60_000;

// ---- Version order ----------------------------------------------------------------------------

// PHP version_compare() order, as WordPress uses it: dev < alpha < beta < RC < number < pl.
const TAG_RANK: Record<string, number> = {
  dev: 0,
  alpha: 1,
  a: 1,
  beta: 2,
  b: 2,
  rc: 3,
  pl: 5,
  p: 5,
};
const NUMBER_RANK = 4;

function tokens(v: string): string[] {
  return v
    .toLowerCase()
    .split(/[.\-_+]/)
    .flatMap((part) => part.match(/\d+|[^\d]+/g) ?? [])
    .filter(Boolean);
}

function rank(token: string | undefined): number {
  if (token === undefined) return NUMBER_RANK; // a missing part counts like ".0"
  if (/^\d+$/.test(token)) return NUMBER_RANK;
  return TAG_RANK[token] ?? -1; // unknown words sort below dev, as in PHP
}

/**
 * Compares two plugin versions: negative when a < b, 0 when equal, positive when a > b.
 * "1.0" equals "1.0.0"; "1.0-beta" < "1.0" < "1.0.1"; "1.0rc1" reads as "1.0.rc.1".
 */
export function compareVersions(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    const rx = rank(x);
    const ry = rank(y);
    if (rx !== ry) return rx - ry;
    if (rx === NUMBER_RANK) {
      const diff = Number(x ?? "0") - Number(y ?? "0");
      if (diff !== 0) return Math.sign(diff);
    } else if (rx === -1 && x !== y) {
      return (x ?? "") < (y ?? "") ? -1 : 1;
    }
  }
  return 0;
}

// ---- Upload and checks ------------------------------------------------------------------------

export const UploadCheckName = z.enum(["file", "archive", "paths", "layout", "plugin", "contents"]);
export const UploadCheck = z.object({
  name: UploadCheckName,
  ok: z.boolean(),
  detail: z.string().max(1000),
});
export type UploadCheck = z.infer<typeof UploadCheck>;

/** What POST /plugins/uploads answers: the checks, the checksum and what the ZIP declares. */
export const PluginUploadResult = z.object({
  ok: z.boolean(),
  /** Set only when every check passed: the quarantined upload to save with a changelog. */
  uploadId: id.nullable(),
  filename: z.string(),
  /** Size and SHA-256 of the ZIP UlixOps keeps (and later deploys). */
  sizeBytes: z.number().int(),
  sha256: Sha256,
  /** The uploaded file's SHA-256 when macOS metadata was left out of the kept copy. */
  uploadedSha256: Sha256.nullable(),
  slug: slug.nullable(),
  name: z.string().nullable(),
  version: version.nullable(),
  requiresWp: z.string().nullable(),
  requiresPhp: z.string().nullable(),
  fileCount: z.number().int(),
  checks: z.array(UploadCheck),
  warnings: z.array(z.string().max(500)).max(50),
  /** Neutral notes, e.g. "Ignored macOS metadata (__MACOSX, .DS_Store)". */
  notes: z.array(z.string().max(500)).max(10),
  /** The registry already has this plugin (a new version) or not (a new plugin). */
  pluginExists: z.boolean(),
  latestVersion: z.string().nullable(),
});
export type PluginUploadResult = z.infer<typeof PluginUploadResult>;

export const CreatePluginVersionRequest = z.object({
  uploadId: id,
  changelog: z.string().trim().min(1).max(5000),
  dbChanging: z.boolean(),
});
export const CreatePluginVersionResponse = z.object({ slug, version });

// ---- Registry views ---------------------------------------------------------------------------

/** Where one site environment stands against the registry's latest version. */
export const InstallStatus = z.enum([
  "latest",
  "outdated",
  /** Higher than anything uploaded, e.g. a build installed by hand. */
  "newer",
  "not_installed",
  /** The environment has no inventory yet (Build Order step 6). */
  "unknown",
]);
export type InstallStatus = z.infer<typeof InstallStatus>;

export const SiteCounts = z.object({
  latest: z.number().int(),
  outdated: z.number().int(),
  newer: z.number().int(),
  notInstalled: z.number().int(),
  unknown: z.number().int(),
});

export const PluginSummary = z.object({
  slug,
  name: z.string(),
  latestVersion: z.string().nullable(),
  latestAt: iso.nullable(),
  versionCount: z.number().int(),
  /** Production environments of active sites (agent decision A64). */
  production: SiteCounts,
});
export type PluginSummary = z.infer<typeof PluginSummary>;
export const PluginList = z.object({ plugins: z.array(PluginSummary) });

export const PluginVersionView = z.object({
  version: z.string(),
  sha256: Sha256,
  sizeBytes: z.number().int(),
  changelog: z.string(),
  dbChanging: z.boolean(),
  requiresWp: z.string().nullable(),
  requiresPhp: z.string().nullable(),
  createdAt: iso,
  uploadedBy: z.object({ id, email: z.string() }).nullable(),
});
export type PluginVersionView = z.infer<typeof PluginVersionView>;

export const SitePluginRow = z.object({
  siteId: id,
  siteName: z.string(),
  kind: EnvKind,
  status: InstallStatus,
  installedVersion: z.string().nullable(),
  /** Active on the site, per the last inventory; null when not installed or unknown. */
  active: z.boolean().nullable(),
  /** The installed version is one UlixOps has in the registry. */
  registered: z.boolean(),
  inventoryAt: iso.nullable(),
});
export type SitePluginRow = z.infer<typeof SitePluginRow>;

export const PluginDetail = PluginSummary.extend({
  versions: z.array(PluginVersionView),
  sites: z.array(SitePluginRow),
});
export type PluginDetail = z.infer<typeof PluginDetail>;
