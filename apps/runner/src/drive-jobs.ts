// Drive connection jobs (A145, A146): what is set up, and "Sign in with Google". The PKCE
// verifier, the code and the refresh token never leave the runner: the API gets Google's consent
// URL and a random state, and sends the code back sealed.
import { createHash, randomBytes } from "node:crypto";
import {
  BACKUP_KEY_REF,
  DRIVE_CLIENT_ID_REF,
  DRIVE_CLIENT_SECRET_REF,
  DRIVE_REFRESH_TOKEN_REF,
  type DriveAuthFinish,
  type DriveAuthStart,
  type DriveDeleteResult,
  type DriveStatusResult,
  GoogleAuthCode,
} from "@ulixops/shared";
import { buildAuthUrl, DriveAuthError, DriveError, exchangeCode, GoogleDrive } from "./drive";
import type { SealKeys } from "./sealed";
import { type Vault, VaultError } from "./vault";

export interface DriveJobDeps {
  vault: Vault;
  seal?: SealKeys;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Sign-ins in progress: state → PKCE verifier. Ten minutes to finish on Google's page. */
const pending = new Map<string, { verifier: string; redirectUri: string; expiresAt: number }>();
const SIGN_IN_MS = 10 * 60_000;

async function read(vault: Vault, name: string): Promise<string | null> {
  try {
    return (await vault.read(name)).trim();
  } catch (error) {
    if (error instanceof VaultError && error.kind === "not_found") return null;
    throw error;
  }
}

async function store(vault: Vault, name: string, value: string): Promise<void> {
  try {
    await vault.create(name, value, "ulixops: Google Drive sign-in");
  } catch (error) {
    if (!(error instanceof VaultError && error.kind === "exists")) throw error;
    await vault.replace(name, value);
  }
}

export async function driveStatus(deps: DriveJobDeps): Promise<DriveStatusResult> {
  const names = new Set((await deps.vault.list()).map((c) => c.name));
  const setup = {
    clientId: names.has(DRIVE_CLIENT_ID_REF),
    clientSecret: names.has(DRIVE_CLIENT_SECRET_REF),
    key: names.has(BACKUP_KEY_REF),
  };
  const base = { setup, connected: false, email: null, limit: null, usage: null };
  if (!setup.clientId || !setup.clientSecret)
    return { ...base, error: "Add the Google Drive client ID and secret below." };
  if (!names.has(DRIVE_REFRESH_TOKEN_REF))
    return { ...base, error: "Not connected yet: click Sign in with Google." };
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    read(deps.vault, DRIVE_CLIENT_ID_REF),
    read(deps.vault, DRIVE_CLIENT_SECRET_REF),
    read(deps.vault, DRIVE_REFRESH_TOKEN_REF),
  ]);
  if (!clientId || !clientSecret || !refreshToken)
    return { ...base, error: "The Drive sign-in is incomplete: sign in again." };
  try {
    const about = await new GoogleDrive(
      { clientId, clientSecret, refreshToken },
      deps.fetchImpl,
    ).about();
    return {
      setup,
      connected: true,
      email: about.email,
      limit: about.limit,
      usage: about.usage,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      error:
        error instanceof DriveAuthError
          ? error.message
          : "Google Drive could not be reached right now.",
    };
  }
}

export async function driveAuthStart(
  redirectUri: string,
  deps: DriveJobDeps,
): Promise<DriveAuthStart> {
  const clientId = await read(deps.vault, DRIVE_CLIENT_ID_REF);
  if (!clientId)
    throw new Error("Add the Google Drive client ID in Settings → Google Drive first.");
  const now = (deps.now ?? Date.now)();
  for (const [s, p] of pending) if (p.expiresAt < now) pending.delete(s);
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  pending.set(state, { verifier, redirectUri, expiresAt: now + SIGN_IN_MS });
  return { authUrl: buildAuthUrl({ clientId, redirectUri, state, codeChallenge }), state };
}

export async function driveAuthFinish(
  job: { state: string; keyId: string; ciphertext: string },
  deps: DriveJobDeps,
): Promise<DriveAuthFinish> {
  const entry = pending.get(job.state);
  pending.delete(job.state);
  if (!entry || entry.expiresAt < (deps.now ?? Date.now)())
    return {
      status: "unknown",
      email: null,
      detail:
        "This sign-in expired or was already used (or the hub restarted). Click Sign in with Google again.",
    };
  if (!deps.seal) throw new Error("Secret sealing is not configured on the runner");
  let code: string;
  try {
    code = deps.seal.open(job.keyId, job.ciphertext);
  } catch {
    return {
      status: "failed",
      email: null,
      detail: "The sign-in reply couldn't be read. Try again.",
    };
  }
  if (!GoogleAuthCode.safeParse(code).success)
    return { status: "failed", email: null, detail: "Google's reply wasn't a sign-in code." };
  const [clientId, clientSecret] = await Promise.all([
    read(deps.vault, DRIVE_CLIENT_ID_REF),
    read(deps.vault, DRIVE_CLIENT_SECRET_REF),
  ]);
  if (!clientId || !clientSecret)
    return { status: "failed", email: null, detail: "The client ID or secret is missing." };
  try {
    const refreshToken = await exchangeCode(
      { clientId, clientSecret, code, redirectUri: entry.redirectUri, verifier: entry.verifier },
      deps.fetchImpl,
    );
    await store(deps.vault, DRIVE_REFRESH_TOKEN_REF, refreshToken);
    const about = await new GoogleDrive({ clientId, clientSecret, refreshToken }, deps.fetchImpl)
      .about()
      .catch(() => ({ email: null }));
    return { status: "connected", email: about.email, detail: "Connected." };
  } catch (error) {
    return {
      status: "failed",
      email: null,
      detail: error instanceof DriveError ? error.message : "Google sign-in failed.",
    };
  }
}

/** Deletes files UlixOps made (expired safety copies, A152). Drive's own scope limits it to those. */
export async function driveDelete(
  fileIds: string[],
  deps: DriveJobDeps,
): Promise<DriveDeleteResult> {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    read(deps.vault, DRIVE_CLIENT_ID_REF),
    read(deps.vault, DRIVE_CLIENT_SECRET_REF),
    read(deps.vault, DRIVE_REFRESH_TOKEN_REF),
  ]);
  if (!clientId || !clientSecret || !refreshToken) return { deleted: [], failed: fileIds };
  const drive = new GoogleDrive({ clientId, clientSecret, refreshToken }, deps.fetchImpl);
  const result: DriveDeleteResult = { deleted: [], failed: [] };
  for (const id of fileIds) {
    const ok = await drive.deleteFile(id).catch(() => false);
    (ok ? result.deleted : result.failed).push(id);
  }
  return result;
}
