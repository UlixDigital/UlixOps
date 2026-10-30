// WP Engine Gateway conventions for smart add-site (A107).
// Install name → {install}.ssh.wpengine.net / user {install} / path under /sites or /home/wpe-user/sites.
import { z } from "zod";
import { WpPath } from "./commands";
import { CredentialRef, SshHost } from "./queue";

/** WP Engine environment / install name (letters, digits, hyphen). */
export const WpEngineInstall = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export type WpEngineInstall = z.infer<typeof WpEngineInstall>;

const WPE_PUBLIC_HOST = /^([a-z0-9-]+)\.(?:wpengine\.com|wpenginepowered\.com)$/i;
const STAGING_SUFFIX = /(?:-stg|stg|staging)$/i;

/** Install name from a *.wpengine.com / *.wpenginepowered.com URL host, else null. */
export function installFromWpEngineUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const match = WPE_PUBLIC_HOST.exec(host);
  const name = match?.[1];
  return name ? name.toLowerCase() : null;
}

/** Production install guessed from a staging install (foostg → foo). */
export function productionInstallFromStaging(stagingInstall: string): string | null {
  const parsed = WpEngineInstall.safeParse(stagingInstall);
  if (!parsed.success) return null;
  const stripped = parsed.data.replace(STAGING_SUFFIX, "");
  if (!stripped || stripped === parsed.data) return null;
  const prod = WpEngineInstall.safeParse(stripped);
  return prod.success ? prod.data : null;
}

export function wpEnginePathCandidates(install: string): [string, string] {
  const name = install.toLowerCase();
  return [`/sites/${name}`, `/home/wpe-user/sites/${name}`];
}

export function wpEngineSshFields(install: string): {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  wpPath: string;
  wpPathCandidates: string[];
} {
  const name = WpEngineInstall.parse(install);
  const [primaryPath, legacyPath] = wpEnginePathCandidates(name);
  return {
    sshHost: `${name}.ssh.wpengine.net`,
    sshUser: name,
    sshPort: 22,
    wpPath: primaryPath,
    wpPathCandidates: [primaryPath, legacyPath],
  };
}

export type ResolveWpEngineEnvInput = {
  url: string;
  credentialRef: string;
  /** When the URL is a custom domain and peer install is not enough. */
  installHint?: string | null;
  /** Other env's install (e.g. staging) used to infer this one. */
  peerInstall?: string | null;
  /** Prefer deriving as production (strip staging suffixes from peer). */
  role: "production" | "staging";
};

export type WpEngineResolvedEnv = {
  url: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  wpPath: string;
  credentialRef: string;
  install: string;
  wpPathCandidates: string[];
};

export type ResolveWpEngineEnvResult =
  { ok: true; data: WpEngineResolvedEnv } | { ok: false; needInstallHint: true; error: string };

function resolveInstall(input: ResolveWpEngineEnvInput): string | null {
  const fromUrl = installFromWpEngineUrl(input.url);
  if (fromUrl) return fromUrl;
  const hint = input.installHint?.trim();
  if (hint) {
    const parsed = WpEngineInstall.safeParse(hint);
    if (parsed.success) return parsed.data;
  }
  const peer = input.peerInstall?.trim();
  if (peer) {
    if (input.role === "production") {
      return productionInstallFromStaging(peer);
    }
    const parsed = WpEngineInstall.safeParse(peer);
    if (parsed.success) {
      // Staging from production install: common pattern {prod}stg
      return `${parsed.data}stg`;
    }
  }
  return null;
}

/** Build full EnvironmentInput for a WP Engine env from URL + vault key (+ optional hint). */
export function resolveWpEngineEnv(input: ResolveWpEngineEnvInput): ResolveWpEngineEnvResult {
  const install = resolveInstall(input);
  if (!install) {
    return {
      ok: false,
      needInstallHint: true,
      error:
        input.role === "production"
          ? "Enter the WP Engine production install name (or use a *.wpengine.com URL)."
          : "Enter the WP Engine staging install name (or use a *.wpengine.com staging URL).",
    };
  }
  let credentialRef: string;
  try {
    credentialRef = CredentialRef.parse(input.credentialRef);
  } catch {
    return { ok: false, needInstallHint: true, error: "Choose a valid SSH key from the vault." };
  }
  let url: string;
  try {
    url = z
      .url({ protocol: /^https?$/ })
      .max(300)
      .parse(input.url);
  } catch {
    return { ok: false, needInstallHint: true, error: "Enter a valid http(s) site URL." };
  }
  const fields = wpEngineSshFields(install);
  SshHost.parse(fields.sshHost);
  for (const path of fields.wpPathCandidates) WpPath.parse(path);
  return {
    ok: true,
    data: {
      url,
      sshHost: fields.sshHost,
      sshPort: fields.sshPort,
      sshUser: fields.sshUser,
      wpPath: fields.wpPath,
      credentialRef,
      install,
      wpPathCandidates: fields.wpPathCandidates,
    },
  };
}
