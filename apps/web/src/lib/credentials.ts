import "server-only";
import { CredentialList } from "@ulixops/shared";
import { apiGet } from "@/lib/api";

/** Names of the SSH keys in the vault, or null when the runner can't list them right now. */
export async function vaultKeyNames(auth: { sessionToken: string; ip: string }) {
  try {
    const res = await apiGet("/credentials", CredentialList, auth, { timeoutMs: 15_000 });
    return res.ok ? res.data.credentials.map((c) => c.name) : null;
  } catch {
    return null;
  }
}
