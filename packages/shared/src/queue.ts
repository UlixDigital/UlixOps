import { z } from "zod";
import { Command, PluginName, WpPath } from "./commands";

/** BullMQ queue for every remote operation. Only apps/runner consumes it. */
export const REMOTE_QUEUE = "remote-ops";

/** Name of the vault secret holding an SSH private key: a reference, never the key itself. */
export const CredentialRef = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "Capitals, digits and _ only, e.g. SSH_KEY_CLIENT_SITE");

/** OpenSSH-style host key fingerprint: SHA256:<43 base64 chars>. */
export const HostKeyFingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);

const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** SSH host: a DNS name or an IPv4 address. Digits-and-dots must be a real IPv4 address. */
export const SshHost = z
  .string()
  .refine(
    (h) => (/^[\d.]+$/.test(h) ? IPV4.test(h) : HOSTNAME.test(h)),
    "Not a valid host name or IPv4 address",
  );

/** How to reach one WordPress environment. No secrets: the runner fetches the key by name. */
export const SshTarget = z.object({
  host: SshHost,
  port: z.number().int().min(1).max(65535),
  user: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  wpPath: WpPath,
  credentialRef: CredentialRef,
  /** Pinned on the first successful test; null means "trust on first use". */
  hostKey: HostKeyFingerprint.nullable(),
});
export type SshTarget = z.infer<typeof SshTarget>;

/** Stable id for a Backup row; also used as the on-disk filename and encryption AAD. */
export const BackupId = z.string().regex(/^[a-z0-9]{1,64}$/);

/** Every job the runner accepts. Job data never contains a secret or free-form shell text. */
export const RunnerJob = z.discriminatedUnion("type", [
  z.object({ type: z.literal("credentials.list") }),
  z.object({ type: z.literal("credentials.create"), name: CredentialRef }),
  z.object({
    type: z.literal("site.test"),
    target: SshTarget,
    /** Extra WordPress paths to try if target.wpPath fails (A107 WP Engine path fallback). */
    wpPathCandidates: z.array(WpPath).max(3).optional(),
  }),
  z.object({
    type: z.literal("site.inventory"),
    target: SshTarget,
    /**
     * When false (default for UI Refresh), skip WP.org/vendor update probes (A114).
     * Automated post-update refreshes pass true.
     */
    checkUpdates: z.boolean().optional(),
  }),
  z.object({ type: z.literal("remote.command"), target: SshTarget, command: Command }),
  z.object({
    type: z.literal("site.snapshot"),
    target: SshTarget,
    backupId: BackupId,
    plugin: PluginName,
    includeDb: z.boolean(),
    /** Defaults to plugin for older jobs (A104). */
    asset: z.enum(["plugin", "theme"]).optional(),
  }),
  z.object({
    type: z.literal("site.snapshot.restore"),
    target: SshTarget,
    backupId: BackupId,
    plugin: PluginName,
    includesDb: z.boolean(),
    asset: z.enum(["plugin", "theme"]).optional(),
    /** Needed to decrypt content-addressed blobs (A103). */
    location: z
      .string()
      .regex(/^quick\/([a-z0-9]{1,64}|content\/[0-9a-f]{64})\.bin$/)
      .optional(),
  }),
  z.object({
    type: z.literal("site.health"),
    target: SshTarget,
    /** Absolute http(s) URLs built by the API from the environment origin + settings paths. */
    urls: z
      .array(z.url({ protocol: /^https?$/ }).max(500))
      .min(1)
      .max(25),
    /** Environment origin, used only to label home vs wp-admin vs extra. */
    origin: z.url({ protocol: /^https?$/ }).max(500),
    thresholdMs: z.number().int().min(500).max(60_000),
    checkErrorLog: z.boolean(),
  }),
  z.object({
    type: z.literal("site.plugin.deploy"),
    target: SshTarget,
    plugin: PluginName,
    /** Content-addressed key under PLUGIN_STORE_DIR, e.g. versions/<sha256>.zip (A63 / A81). */
    storageKey: z.string().regex(/^versions\/[0-9a-f]{64}\.zip$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type RunnerJob = z.infer<typeof RunnerJob>;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ---- Results the runner returns (validated again by the API) -------------------------------

export const CredentialInfo = z.object({
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CredentialInfo = z.infer<typeof CredentialInfo>;
export const CredentialsListResult = z.object({ credentials: z.array(CredentialInfo) });
export const CredentialCreatedResult = z.object({
  name: CredentialRef,
  /** OpenSSH public key line to install on the host; the private key stays in the vault. */
  publicKey: z.string().startsWith("ssh-ed25519 "),
});

export const TestStep = z.object({
  name: z.enum(["vault", "ssh", "wp-cli", "wordpress"]),
  ok: z.boolean(),
  detail: z.string(),
});
export const SiteTestResult = z.object({
  ok: z.boolean(),
  steps: z.array(TestStep),
  /** The fingerprint the server presented (pin it after the first successful test). */
  hostKey: HostKeyFingerprint.nullable(),
  hostKeyMismatch: z.boolean(),
  wpVersion: z.string().nullable(),
  phpVersion: z.string().nullable(),
  wpCliVersion: z.string().nullable(),
  /** Path that passed the WordPress step (may differ from the request after fallback). */
  wpPath: WpPath.nullable().optional(),
  durationMs: z.number(),
});
export type SiteTestResult = z.infer<typeof SiteTestResult>;

/** The server presented a different host key than the pinned one, so nothing ran. */
export const HostKeyMismatchResult = z.object({
  hostKeyMismatch: z.literal(true),
  expected: HostKeyFingerprint,
  presented: HostKeyFingerprint,
});

export const RemoteCommandResult = z.discriminatedUnion("hostKeyMismatch", [
  HostKeyMismatchResult,
  z.object({
    hostKeyMismatch: z.literal(false),
    exitCode: z.number(),
    stdout: z.string().max(200_100),
    stderr: z.string().max(20_100),
    hostKey: HostKeyFingerprint,
    durationMs: z.number(),
  }),
]);
export type RemoteCommandResult = z.infer<typeof RemoteCommandResult>;

/** One plugin or theme as `wp plugin list` / `wp theme list` reports it, normalised. */
export const InventoryItem = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(300),
  /** WP-CLI status: active, inactive, active-network, must-use, dropin; themes: parent. */
  status: z.enum(["active", "inactive", "active-network", "must-use", "dropin", "parent"]),
  version: z.string().max(50),
  /** Version offered by the update source, or null when up to date (or unknown). */
  updateVersion: z.string().max(50).nullable(),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

export const MAX_INVENTORY_ITEMS = 1000;

/** `site.inventory`: versions, plugins, themes and maintenance mode, read over WP-CLI. */
export const SiteInventoryResult = z.discriminatedUnion("hostKeyMismatch", [
  HostKeyMismatchResult,
  z.object({
    hostKeyMismatch: z.literal(false),
    hostKey: HostKeyFingerprint,
    wpVersion: z.string().max(50),
    phpVersion: z.string().max(50),
    wpCliVersion: z.string().max(50),
    plugins: z.array(InventoryItem).max(MAX_INVENTORY_ITEMS),
    themes: z.array(InventoryItem).max(MAX_INVENTORY_ITEMS),
    /** null when WP-CLI couldn't tell. */
    maintenance: z.boolean().nullable(),
    /** Plugins and themes had to be skipped to read the site: it is probably broken. */
    safeMode: z.boolean(),
    /** Redacted notes on what could not be read. */
    warnings: z.array(z.string().max(600)).max(10),
    durationMs: z.number(),
  }),
]);
export type SiteInventoryResult = z.infer<typeof SiteInventoryResult>;

/** Result of capturing or restoring a quick snapshot (Build Order step 8). */
export const SnapshotJobResult = z.discriminatedUnion("hostKeyMismatch", [
  HostKeyMismatchResult,
  z.object({
    hostKeyMismatch: z.literal(false),
    ok: z.boolean(),
    hostKey: HostKeyFingerprint,
    pluginVersion: z.string().max(50).nullable(),
    includesDb: z.boolean(),
    /** Plaintext content hash (also encryption AAD for content-addressed blobs, A103). */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    /** Relative store path, e.g. quick/content/<sha>.bin or legacy quick/<backupId>.bin. */
    location: z
      .string()
      .regex(/^quick\/([a-z0-9]{1,64}|content\/[0-9a-f]{64})\.bin$/)
      .nullable(),
    reused: z.boolean().optional(),
    detail: z.string().max(2000),
    durationMs: z.number(),
  }),
]);
export type SnapshotJobResult = z.infer<typeof SnapshotJobResult>;

/** Result of installing a registry plugin ZIP over SFTP (Build Order step 10). */
export const PluginDeployResult = z.discriminatedUnion("hostKeyMismatch", [
  HostKeyMismatchResult,
  z.object({
    hostKeyMismatch: z.literal(false),
    ok: z.boolean(),
    hostKey: HostKeyFingerprint,
    detail: z.string().max(2000),
    durationMs: z.number(),
  }),
]);
export type PluginDeployResult = z.infer<typeof PluginDeployResult>;
