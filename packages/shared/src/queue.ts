import { z } from "zod";
import { DriveFileId, RestoreScope } from "./backups";
import { CfId, DnsChangeOp, MAX_DNS_CHANGES, MAX_PURGE_URLS } from "./dns";
import { DebugConstants } from "./errorlog";
import { ExpiryCheckRequest, MAX_EXPIRY_HOSTS, MAX_UPTIME_PROBES, UptimeProbe } from "./monitoring";
import { Command, PluginName, SiteAddress, WpPath } from "./commands";
import { SiteFilesOp } from "./files";
import { API_KEY_NAMES, MAX_WANTED_SOFTWARE, WantedSoftware } from "./vulnerabilities";
import { MAX_VISUAL_PAGES, VisualCaptureMode, VisualPageRequest } from "./visual";

/** BullMQ queue for every remote operation. Only apps/runner consumes it. */
export const REMOTE_QUEUE = "remote-ops";

/**
 * Separate queue for the 5-minute uptime probes (A149), so they never wait behind long SSH
 * jobs (scans, backups) and get refused as stale. Only apps/runner consumes it.
 */
export const MONITOR_QUEUE = "monitor-ops";
/**
 * Job types that go to MONITOR_QUEUE; its worker refuses anything else. Quick network-only jobs
 * (uptime probes, Cloudflare API calls, A156) that must never wait behind SSH work.
 */
export const MONITOR_JOB_TYPES = [
  "monitor.uptime",
  "dns.zones",
  "dns.records",
  "dns.apply",
  "dns.purge",
] as const;

/**
 * Playwright screenshots (A163) can take minutes; they get their own queue so they never block
 * the 5-minute uptime probes on monitor-ops, and never wait behind malware/backup SSH work.
 */
export const VISUAL_QUEUE = "visual-ops";
export const VISUAL_JOB_TYPES = ["site.visual.capture"] as const;

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

/** How to reach one WordPress environment. No secrets: the runner fetches the key/password by name. */
export const SshTarget = z.object({
  host: SshHost,
  port: z.number().int().min(1).max(65535),
  user: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  wpPath: WpPath,
  credentialRef: CredentialRef,
  /** Pinned on the first successful test; null means "trust on first use". */
  hostKey: HostKeyFingerprint.nullable(),
  /**
   * Dedicated SFTP endpoint (A180): do not fall back to ShellFs over SSH exec when the SFTP
   * subsystem is missing — that path is what makes WP Engine SSH gateway feel slow.
   */
  nativeSftpOnly: z.boolean().optional(),
  /**
   * How to authenticate with `credentialRef` (A182). Default `key` (SSH private key).
   * `password` = vault secret is an SFTP password (Files dedicated endpoint only).
   */
  authMode: z.enum(["key", "password"]).optional(),
});
export type SshTarget = z.infer<typeof SshTarget>;

/** Vault secret name for a Files-tab SFTP password (A182). Never an SSH private key. */
export const FilesSftpPasswordRef = CredentialRef.refine(
  (n) => n.startsWith("FILES_SFTP_"),
  "Files SFTP password refs must start with FILES_SFTP_",
);
export type FilesSftpPasswordRef = z.infer<typeof FilesSftpPasswordRef>;

/** Stable id for a Backup row; also used as the on-disk filename and encryption AAD. */
export const BackupId = z.string().regex(/^[a-z0-9]{1,64}$/);

/** Identifies the runner's current sealing key pair (it changes when the runner restarts). */
export const SealKeyId = z.string().regex(/^[0-9a-f]{32}$/);

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
  z.object({
    /** Stream the Wordfence feed and return records for this software only (A132). */
    type: z.literal("vuln.feed"),
    wanted: z.array(WantedSoftware).min(1).max(MAX_WANTED_SOFTWARE),
  }),
  /**
   * Copy the site's code files to the scan-work volume and have the scanner sidecar scan
   * them (A138). Read-only on the site.
   */
  z.object({
    type: z.literal("site.malware.scan"),
    target: SshTarget,
    scanId: BackupId,
    /** Files in the last scan of this environment, to estimate copy progress (A143). */
    expectedFiles: z.number().int().positive().max(10_000_000).optional(),
  }),
  /**
   * Full backup to Google Drive (A145): health checked by the API first; dump the database,
   * stream an encrypted tar.gz of the site to Drive, verify it, then delete `oldFileIds`.
   */
  z.object({
    type: z.literal("site.backup"),
    target: SshTarget,
    backupId: BackupId,
    /** Drive folder for this environment: a stable key and a readable name. */
    folderKey: BackupId,
    folderName: z.string().min(1).max(120),
    fileStem: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/),
    /** Size of the last backup, to estimate progress. */
    expectedBytes: z.number().int().positive().optional(),
    oldFileIds: z.array(DriveFileId).max(50),
  }),
  z.object({ type: z.literal("site.backup.cancel"), backupId: BackupId }),
  /**
   * Restore a full backup from Drive (A152), after an approved ApprovalRequest: check the key,
   * take a safety copy (as site.backup, kept separately), then stream the backup into the site.
   */
  z.object({
    type: z.literal("site.backup.restore"),
    target: SshTarget,
    restoreId: BackupId,
    /** The backup to restore: its Drive file, and its row id (names the dump inside it). */
    driveFileId: DriveFileId,
    sourceBackupId: BackupId,
    scope: RestoreScope,
    /**
     * Restoring another environment's backup (A157): the database's site address is changed
     * from `from` to `to`, and the table prefixes must match.
     */
    rewrite: z.object({ from: SiteAddress, to: SiteAddress }).optional(),
    /** The safety copy's row id, Drive folder and file name (like site.backup). */
    safetyBackupId: BackupId,
    folderKey: BackupId,
    folderName: z.string().min(1).max(120),
    fileStem: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/),
    expectedBytes: z.number().int().positive().optional(),
  }),
  /** The end of wp-content/debug.log, grouped (A159). Read-only. */
  z.object({
    type: z.literal("site.errorlog"),
    target: SshTarget,
    /** Cut a log above ERRORLOG_TRIM_ABOVE (only when UlixOps switched logging on, A160). */
    trim: z.boolean().optional(),
  }),
  /**
   * Switch PHP error logging on via UlixOps mu-plugin + private log (A167), or remove it.
   * Legacy `restore` kept for sites still managed via wp-config (A160).
   */
  z.object({
    type: z.literal("site.debuglog"),
    target: SshTarget,
    action: z.enum(["enable", "disable"]),
    siteUrl: z.url({ protocol: /^https?$/ }).max(500),
    restore: DebugConstants.optional(),
  }),
  /** Delete files UlixOps made on Drive: expired safety copies (A152). */
  z.object({ type: z.literal("drive.delete"), fileIds: z.array(DriveFileId).min(1).max(50) }),
  /** Drive connection: what is set up, and the account's storage (A145). */
  z.object({ type: z.literal("drive.status") }),
  /** "Sign in with Google": the consent page URL (PKCE verifier stays in the runner). */
  z.object({ type: z.literal("drive.auth.start"), redirectUri: z.url().max(300) }),
  /** Google's reply: the code is sealed to the runner, like API keys (A133). */
  z.object({
    type: z.literal("drive.auth.finish"),
    state: z.string().regex(/^[a-f0-9]{32}$/),
    keyId: SealKeyId,
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(1024),
  }),
  /** Check core and WordPress.org plugin files against official checksums (A144). */
  z.object({ type: z.literal("site.integrity"), target: SshTarget }),
  /**
   * Browse / mutate files under the environment's wpPath over SFTP (A179). Content may be
   * included for write (base64, ≤ 1 MiB); never logged by the API.
   */
  z.object({ type: z.literal("site.files"), target: SshTarget, op: SiteFilesOp }),
  /** Certificates and domain registrations: TLS handshakes and RDAP lookups, no SSH (A148). */
  z.object({
    type: z.literal("monitor.expiry"),
    checks: z.array(ExpiryCheckRequest).min(1).max(MAX_EXPIRY_HOSTS),
  }),
  /** Uptime: fetch each production homepage, no SSH (A149). Runs on MONITOR_QUEUE. */
  /** Cloudflare (A156): every zone the token can see. */
  z.object({ type: z.literal("dns.zones") }),
  z.object({ type: z.literal("dns.records"), zoneId: CfId }),
  /** Record changes in order; stops at the first failure. */
  z.object({
    type: z.literal("dns.apply"),
    zoneId: CfId,
    changes: z.array(DnsChangeOp).min(1).max(MAX_DNS_CHANGES),
  }),
  z.object({
    type: z.literal("dns.purge"),
    zoneId: CfId,
    everything: z.boolean(),
    urls: z.array(z.url({ protocol: /^https?$/ }).max(2000)).max(MAX_PURGE_URLS),
  }),
  z.object({
    type: z.literal("monitor.uptime"),
    probes: z.array(UptimeProbe).min(1).max(MAX_UPTIME_PROBES),
  }),
  /**
   * Before/after (or once) screenshots via the Playwright sidecar (A163). No SSH, no vault —
   * public pages only. `sshHost` is used only to rewrite loopback / published test-wp URLs.
   */
  z.object({
    type: z.literal("site.visual.capture"),
    checkId: BackupId,
    mode: VisualCaptureMode,
    pages: z.array(VisualPageRequest).min(1).max(MAX_VISUAL_PAGES),
    sshHost: SshHost,
    viewportWidth: z.number().int().min(320).max(1920),
    viewportHeight: z.number().int().min(240).max(1080),
    maxDiffPercent: z.number().min(0.01).max(50),
    pixelThreshold: z.number().min(0).max(1),
  }),
  /** Stop a running (or not yet started) malware scan (A143). */
  z.object({ type: z.literal("site.malware.cancel"), scanId: BackupId }),
  /** The runner's in-memory public key for sealing a secret to it (A133). */
  z.object({ type: z.literal("secrets.publicKey") }),
  /** Store an integration API key in the vault. Only ciphertext travels on the queue (A133). */
  z.object({
    type: z.literal("secrets.set"),
    name: z.enum(API_KEY_NAMES),
    keyId: SealKeyId,
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(1024),
  }),
  /** Store a Files-tab SFTP password in the vault (A182). Ciphertext only on the queue. */
  z.object({
    type: z.literal("secrets.setFilesSftpPassword"),
    name: FilesSftpPasswordRef,
    keyId: SealKeyId,
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(1024),
  }),
]);
export type RunnerJob = z.infer<typeof RunnerJob>;

/** Which queue a job goes to. */
export function queueForJob(type: RunnerJob["type"]): string {
  if ((VISUAL_JOB_TYPES as readonly string[]).includes(type)) return VISUAL_QUEUE;
  if ((MONITOR_JOB_TYPES as readonly string[]).includes(type)) return MONITOR_QUEUE;
  return REMOTE_QUEUE;
}

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
    /** Update sources were asked (Check for updates), so "no update" means up to date (A135). */
    updatesChecked: z.boolean().optional(),
    /** Newest WordPress release offered, or null when core is current / it wasn't checked. */
    coreUpdateVersion: z.string().max(30).nullable().optional(),
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

/** `secrets.publicKey`: RSA-OAEP (SHA-256) public key, PEM (A133). */
export const SealKeyResult = z.object({
  keyId: SealKeyId,
  publicKey: z.string().startsWith("-----BEGIN PUBLIC KEY-----").max(2000),
});
export type SealKeyResult = z.infer<typeof SealKeyResult>;

/** `secrets.set`: never echoes the value. */
export const SecretSetResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), updatedAt: z.iso.datetime() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["stale_key", "invalid", "vault_unavailable"]),
    detail: z.string().max(300),
  }),
]);
export type SecretSetResult = z.infer<typeof SecretSetResult>;

/** One scanner detection (ClamAV signature or YARA rule, A140). Paths are relative to the WordPress root. */
export const MalwareFinding = z.object({
  path: z.string().max(1000),
  signatureId: z.string().max(50),
  signatureName: z.string().max(300),
  description: z.string().max(1000),
});
export type MalwareFinding = z.infer<typeof MalwareFinding>;

export const MAX_MALWARE_FINDINGS = 1000;

/** `site.malware.scan` result (A138). */
export const MalwareScanResult = z.discriminatedUnion("hostKeyMismatch", [
  HostKeyMismatchResult,
  z.object({
    hostKeyMismatch: z.literal(false),
    hostKey: HostKeyFingerprint,
    /** The scan ran to the end (findings may still be empty or present). */
    ok: z.boolean(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    /** The site was bigger than the copy limits; only part of it was scanned. */
    truncated: z.boolean(),
    findings: z.array(MalwareFinding).max(MAX_MALWARE_FINDINGS),
    /** Plain-language summary or failure reason (redacted). */
    detail: z.string().max(2000),
    durationMs: z.number(),
    /** Stopped on request (site.malware.cancel), A143. */
    cancelled: z.boolean().optional(),
  }),
]);
export type MalwareScanResult = z.infer<typeof MalwareScanResult>;
