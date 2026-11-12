// `secrets.set` (A133): open a sealed integration API key and store it in the vault. The value
// is never logged, returned, or included in an error message. Also `secrets.setFilesSftpPassword` (A182).
import { apiKeyValueFor, FilesSftpPasswordRef, type SecretSetResult } from "@ulixops/shared";
import { z } from "zod";
import { type SealKeys, StaleSealKeyError } from "./sealed";
import { type Vault, VaultError } from "./vault";

const FilesSftpPassword = z.string().min(1).max(128);

export async function setApiKey(
  job: { name: string; keyId: string; ciphertext: string },
  deps: { vault: Vault; seal: SealKeys; now?: () => number },
): Promise<SecretSetResult> {
  let plain: string;
  try {
    plain = deps.seal.open(job.keyId, job.ciphertext);
  } catch (error) {
    if (error instanceof StaleSealKeyError)
      return { ok: false, reason: "stale_key", detail: "The runner restarted; try again." };
    return { ok: false, reason: "invalid", detail: "The sealed value could not be opened." };
  }
  const value = apiKeyValueFor(job.name).safeParse(plain);
  if (!value.success)
    return { ok: false, reason: "invalid", detail: "That doesn't look like an API key." };

  try {
    try {
      await deps.vault.create(job.name, value.data, "ulixops: integration API key");
    } catch (error) {
      if (!(error instanceof VaultError && error.kind === "exists")) throw error;
      await deps.vault.replace(job.name, value.data);
    }
  } catch {
    return { ok: false, reason: "vault_unavailable", detail: "The vault write failed." };
  }
  return { ok: true, updatedAt: new Date((deps.now ?? Date.now)()).toISOString() };
}

/** Store a Files-tab SFTP password (A182). Value never logged or returned. */
export async function setFilesSftpPassword(
  job: { name: string; keyId: string; ciphertext: string },
  deps: { vault: Vault; seal: SealKeys; now?: () => number },
): Promise<SecretSetResult> {
  if (!FilesSftpPasswordRef.safeParse(job.name).success)
    return { ok: false, reason: "invalid", detail: "Not a Files SFTP password name." };
  let plain: string;
  try {
    plain = deps.seal.open(job.keyId, job.ciphertext);
  } catch (error) {
    if (error instanceof StaleSealKeyError)
      return { ok: false, reason: "stale_key", detail: "The runner restarted; try again." };
    return { ok: false, reason: "invalid", detail: "The sealed value could not be opened." };
  }
  const value = FilesSftpPassword.safeParse(plain);
  if (!value.success)
    return { ok: false, reason: "invalid", detail: "That password is empty or too long." };

  try {
    try {
      await deps.vault.create(job.name, value.data, "ulixops: Files SFTP password");
    } catch (error) {
      if (!(error instanceof VaultError && error.kind === "exists")) throw error;
      await deps.vault.replace(job.name, value.data);
    }
  } catch {
    return { ok: false, reason: "vault_unavailable", detail: "The vault write failed." };
  }
  return { ok: true, updatedAt: new Date((deps.now ?? Date.now)()).toISOString() };
}
