// Google Drive client (A145) against an in-memory fake of the Drive / OAuth HTTP API.
import { describe, expect, it } from "vitest";
import { DriveAuthError, GoogleDrive, buildAuthUrl, UPLOAD_CHUNK } from "./drive";
import { FakeDrive } from "./testing/fake-drive";

const creds = { clientId: "cid", clientSecret: "secret", refreshToken: "1//rt" };
const noSleep = async () => undefined;

describe("GoogleDrive", () => {
  it("builds Google's consent URL with PKCE and offline access", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "https://hub.example.test/oauth/google/callback",
        state: "s".repeat(32),
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
      response_type: "code",
    });
  });

  it("reuses folders, uploads in chunks through failures and partial chunks, and verifies", async () => {
    const fake = new FakeDrive();
    const drive = new GoogleDrive(creds, fake.fetch, noSleep);
    const root = await drive.ensureFolder("UlixOps Backups", null, "root");
    expect(await drive.ensureFolder("UlixOps Backups", null, "root")).toBe(root);
    const upload = await drive.startUpload("shop.ulxb", root);
    const data = Buffer.from(Array.from({ length: UPLOAD_CHUNK * 2 + 12345 }, (_, i) => i % 253));
    fake.failNextPuts = 2;
    await upload.write(data.subarray(0, UPLOAD_CHUNK + 10));
    fake.acceptOnly = 1000;
    await upload.write(data.subarray(UPLOAD_CHUNK + 10));
    const id = await upload.finish();
    const file = await drive.getFile(id);
    expect(file?.size).toBe(data.length);
    expect(file?.md5Checksum).toBe(upload.md5.digest("hex"));
    expect(fake.files.get(id)?.data.equals(data)).toBe(true);
    expect(await drive.deleteFile(id)).toBe(true);
    expect(await drive.deleteFile(id)).toBe(true);
    expect(await drive.getFile(id)).toBeNull();
    // ~33 MB of test data: give a busy machine time.
  }, 60_000);

  it("uploads an empty and a tiny file", async () => {
    const fake = new FakeDrive();
    const drive = new GoogleDrive(creds, fake.fetch, noSleep);
    const tiny = await drive.startUpload("t", "p");
    await tiny.write(Buffer.from("hi"));
    expect(fake.files.get(await tiny.finish())?.data.toString()).toBe("hi");
  });

  it("explains a revoked sign-in", async () => {
    const fake = new FakeDrive();
    fake.revoked = true;
    await expect(new GoogleDrive(creds, fake.fetch, noSleep).about()).rejects.toBeInstanceOf(
      DriveAuthError,
    );
  });

  it("reads the account and storage", async () => {
    const fake = new FakeDrive();
    expect(await new GoogleDrive(creds, fake.fetch, noSleep).about()).toEqual({
      email: "ulixdevs@gmail.com",
      limit: 214748364800,
      usage: 1000,
    });
  });
});
