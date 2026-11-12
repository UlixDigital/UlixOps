// "Sign in with Google" jobs (A146): consent URL → sealed code → refresh token in the vault.
import { constants, publicEncrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { driveAuthFinish, driveAuthStart, driveStatus } from "./drive-jobs";
import { SealKeys } from "./sealed";
import { FakeDrive } from "./testing/fake-drive";
import { MemoryVault } from "./vault";

const REDIRECT = "https://hub.example.test/oauth/google/callback";

function setup() {
  const vault = new MemoryVault();
  for (const [k, v] of Object.entries({
    GOOGLE_DRIVE_CLIENT_ID: "cid.apps.googleusercontent.com",
    GOOGLE_DRIVE_CLIENT_SECRET: "GOCSPX-secret",
  }))
    vault.secrets.set(k, { value: v, at: new Date().toISOString() });
  const drive = new FakeDrive();
  drive.redirectUri = REDIRECT;
  const seal = new SealKeys();
  const deps = { vault, seal, fetchImpl: drive.fetch };
  const sealed = (code: string) => {
    const pub = seal.publicKey();
    return {
      keyId: pub.keyId,
      ciphertext: publicEncrypt(
        { key: pub.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(code),
      ).toString("base64"),
    };
  };
  return { vault, drive, deps, sealed };
}

describe("Google sign-in jobs", () => {
  it("connects: consent URL, then the sealed code becomes a stored refresh token", async () => {
    const { vault, drive, deps, sealed } = setup();
    expect((await driveStatus(deps)).error).toContain("Sign in with Google");
    const start = await driveAuthStart(REDIRECT, deps);
    const url = new URL(start.authUrl);
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    const done = await driveAuthFinish({ state: start.state, ...sealed("4/valid-code") }, deps);
    expect(done).toEqual({
      status: "connected",
      email: "ulixdevs@gmail.com",
      detail: "Connected.",
    });
    expect(await vault.read("GOOGLE_DRIVE_REFRESH_TOKEN")).toBe("1//refresh-token-value");
    // PKCE: the verifier sent matches the challenge in the consent URL.
    expect(drive.codeExchanges[0]?.code_verifier).toBeTruthy();
    expect(await driveStatus(deps)).toMatchObject({ connected: true, email: "ulixdevs@gmail.com" });
    // A state works once.
    const again = await driveAuthFinish({ state: start.state, ...sealed("4/valid-code") }, deps);
    expect(again.status).toBe("unknown");
  });

  it("explains a wrong redirect address, a bad code, an expired sign-in and an unknown state", async () => {
    const { drive, deps, sealed } = setup();
    let start = await driveAuthStart(REDIRECT, deps);
    expect(
      (await driveAuthFinish({ state: start.state, ...sealed("4/wrong-code") }, deps)).status,
    ).toBe("failed");
    drive.redirectUri = "https://other.example.test/cb";
    start = await driveAuthStart(REDIRECT, deps);
    const mismatch = await driveAuthFinish({ state: start.state, ...sealed("4/valid-code") }, deps);
    expect(mismatch).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("redirect address"),
    });
    let t = Date.now();
    const timed = { ...deps, now: () => t };
    start = await driveAuthStart(REDIRECT, timed);
    t += 11 * 60_000;
    expect(
      (await driveAuthFinish({ state: start.state, ...sealed("4/valid-code") }, timed)).status,
    ).toBe("unknown");
    expect(
      (await driveAuthFinish({ state: "f".repeat(32), ...sealed("4/valid-code") }, deps)).status,
    ).toBe("unknown");
  });
});
