import { constants, publicEncrypt } from "node:crypto";
import { RunnerJob, SealKeyResult, SecretSetResult, WORDFENCE_KEY_REF } from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { handleJob } from "./jobs";
import { SealKeys } from "./sealed";
import type { SshConnector } from "./ssh";
import { MemoryVault } from "./vault";

const KEY = "wf_live_0123456789abcdefABCDEF";
const noSsh: SshConnector = {
  connect: async () => {
    throw new Error("no SSH in these tests");
  },
};

/** What the API does: seal the value to the runner's public key. */
function seal(publicKey: string, value: string): string {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(value, "utf8"),
  ).toString("base64");
}

describe("secrets.publicKey / secrets.set", () => {
  it("stores a sealed key in the vault, creating then replacing it", async () => {
    const vault = new MemoryVault();
    const deps = { vault, ssh: noSsh, seal: new SealKeys() };
    const pub = SealKeyResult.parse(await handleJob({ type: "secrets.publicKey" }, deps));

    const job = { type: "secrets.set", name: WORDFENCE_KEY_REF, keyId: pub.keyId };
    // Only ciphertext goes on the queue, and it passes the job schema.
    const first = { ...job, ciphertext: seal(pub.publicKey, KEY) };
    expect(JSON.stringify(RunnerJob.parse(first))).not.toContain(KEY);
    expect(SecretSetResult.parse(await handleJob(first, deps))).toMatchObject({ ok: true });
    expect(await vault.read(WORDFENCE_KEY_REF)).toBe(KEY);

    const replaced = await handleJob(
      { ...job, ciphertext: seal(pub.publicKey, `${KEY}-v2`) },
      deps,
    );
    expect(JSON.stringify(replaced)).not.toContain(KEY);
    expect(await vault.read(WORDFENCE_KEY_REF)).toBe(`${KEY}-v2`);
  });

  it("refuses ciphertext sealed to a previous runner key", async () => {
    const old = new SealKeys().publicKey();
    const deps = { vault: new MemoryVault(), ssh: noSsh, seal: new SealKeys() };
    const result = await handleJob(
      {
        type: "secrets.set",
        name: WORDFENCE_KEY_REF,
        keyId: old.keyId,
        ciphertext: seal(old.publicKey, KEY),
      },
      deps,
    );
    expect(result).toMatchObject({ ok: false, reason: "stale_key" });
    expect(deps.vault.secrets.size).toBe(0);
  });

  it("refuses values that aren't API keys, and garbage ciphertext", async () => {
    const deps = { vault: new MemoryVault(), ssh: noSsh, seal: new SealKeys() };
    const pub = deps.seal.publicKey();
    const set = (ciphertext: string) =>
      handleJob(
        { type: "secrets.set", name: WORDFENCE_KEY_REF, keyId: pub.keyId, ciphertext },
        deps,
      );
    expect(await set(seal(pub.publicKey, "has spaces in it, not a key"))).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(await set(Buffer.from("not sealed").toString("base64"))).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(deps.vault.secrets.size).toBe(0);
  });

  it("only accepts known key names", async () => {
    const deps = { vault: new MemoryVault(), ssh: noSsh, seal: new SealKeys() };
    const pub = deps.seal.publicKey();
    await expect(
      handleJob(
        {
          type: "secrets.set",
          name: "SHOP_SSH_KEY",
          keyId: pub.keyId,
          ciphertext: seal(pub.publicKey, KEY),
        },
        deps,
      ),
    ).rejects.toThrow();
  });
});

describe("secrets.setFilesSftpPassword", () => {
  it("stores a sealed SFTP password under FILES_SFTP_*", async () => {
    const vault = new MemoryVault();
    const deps = { vault, ssh: noSsh, seal: new SealKeys() };
    const pub = SealKeyResult.parse(await handleJob({ type: "secrets.publicKey" }, deps));
    const name = "FILES_SFTP_TESTENV1";
    const password = "sftp-pass-from-filezilla";
    const job = {
      type: "secrets.setFilesSftpPassword" as const,
      name,
      keyId: pub.keyId,
      ciphertext: seal(pub.publicKey, password),
    };
    expect(JSON.stringify(RunnerJob.parse(job))).not.toContain(password);
    expect(SecretSetResult.parse(await handleJob(job, deps))).toMatchObject({ ok: true });
    expect(await vault.read(name)).toBe(password);
  });
});
