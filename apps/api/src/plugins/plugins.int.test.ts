// Plugin registry through the HTTP routes: checked uploads, versions, site matrix (real Postgres).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { finderZip, makeZip, pluginZip } from "../../test/zip";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import { PluginStore } from "./store";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 29, 12, 0, 0));

describe.runIf(TEST_DATABASE_URL)("plugin registry (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let dir = "";
  let app: ReturnType<typeof createApp>;
  const auth = new AuthService({
    db,
    guard: new LoginGuard(new MemoryCounter(now), SECRET),
    notifier: { alert: async () => {} },
    now,
    sessionSecret: SECRET,
    totpKey: "ab".repeat(32),
    issuer: "UlixOps",
    webauthn: { rpID: "localhost", rpName: "UlixOps", origin: "http://localhost:3000" },
    dummyPasswordHash: "unused",
  });

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      post: (p: string, body: object) => set(request(app).post(p)).send(body),
      upload: (zip: Buffer, filename = "ulix-forms.zip") =>
        set(request(app).post(`/plugins/uploads?filename=${encodeURIComponent(filename)}`))
          .set("content-type", "application/zip")
          .send(zip),
    };
  };
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER", email?: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, ...(email ? { email } : {}) });
  const files = async (sub: string) => {
    try {
      return await readdir(path.join(dir, sub));
    } catch {
      return [];
    }
  };

  /** Uploads and saves one version; returns the check result. */
  async function publish(token: string, zip: Buffer, changelog = "First release") {
    const check = await as(token).upload(zip).expect(200);
    expect(check.body.ok).toBe(true);
    await as(token)
      .post("/plugins/versions", { uploadId: check.body.uploadId, changelog, dbChanging: false })
      .expect(201);
    return check.body;
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(tmpdir(), "ulixops-plugins-"));
    app = createApp({ auth, db, now, pluginStore: new PluginStore(dir), sessionSecret: SECRET });
  });
  afterAll(async () => {
    await db.$disconnect();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("checks a ZIP, quarantines it, then saves it as a version with its changelog", async () => {
    const dev = await make("DEVELOPER");
    const check = await as(dev.token).upload(pluginZip(), "ulix-forms-1.2.0.zip").expect(200);
    expect(check.body).toMatchObject({
      ok: true,
      filename: "ulix-forms-1.2.0.zip",
      slug: "ulix-forms",
      name: "Ulix Forms",
      version: "1.2.0",
      requiresWp: "6.4",
      requiresPhp: "8.1",
      pluginExists: false,
      latestVersion: null,
    });
    expect(check.body.uploadId).toMatch(/^[a-z0-9]+$/);
    expect(await files("uploads")).toEqual([`${check.body.uploadId}.zip`]);
    expect(await files("versions")).toEqual([]);

    const saved = await as(dev.token)
      .post("/plugins/versions", {
        uploadId: check.body.uploadId,
        changelog: "Adds the contact form block.",
        dbChanging: true,
      })
      .expect(201);
    expect(saved.body).toEqual({ slug: "ulix-forms", version: "1.2.0" });
    expect(await files("uploads")).toEqual([]);
    expect(await files("versions")).toEqual([`${check.body.sha256}.zip`]);
    expect(await db.pluginUpload.count()).toBe(0);

    const detail = await as(dev.token).get("/plugins/ulix-forms").expect(200);
    expect(detail.body).toMatchObject({
      slug: "ulix-forms",
      latestVersion: "1.2.0",
      versionCount: 1,
      versions: [
        {
          version: "1.2.0",
          sha256: check.body.sha256,
          changelog: "Adds the contact form block.",
          dbChanging: true,
          uploadedBy: { email: "developer@example.test" },
        },
      ],
    });
    const audits = await db.auditLog.findMany({ where: { action: { startsWith: "plugin." } } });
    expect(audits.map((a) => [a.action, a.result]).sort()).toEqual([
      ["plugin.upload.check", "success"],
      ["plugin.version.create", "success"],
    ]);
  });

  it("accepts a Finder ZIP and keeps a copy without the macOS metadata", async () => {
    const dev = await make("DEVELOPER");
    const upload = finderZip();
    const check = await as(dev.token).upload(upload).expect(200);
    expect(check.body).toMatchObject({
      ok: true,
      slug: "ulix-forms",
      version: "1.2.0",
      fileCount: 2,
      uploadedSha256: createHash("sha256").update(upload).digest("hex"),
      notes: ["Ignored macOS metadata (__MACOSX, .DS_Store)", expect.stringMatching(/left out/)],
    });
    // Quarantined: the cleaned copy, whose checksum is the one shown.
    const quarantined = readFileSync(path.join(dir, "uploads", `${check.body.uploadId}.zip`));
    expect(createHash("sha256").update(quarantined).digest("hex")).toBe(check.body.sha256);
    expect(quarantined.includes(Buffer.from("__MACOSX"))).toBe(false);
    expect(quarantined.includes(Buffer.from(".DS_Store"))).toBe(false);

    await as(dev.token)
      .post("/plugins/versions", {
        uploadId: check.body.uploadId,
        changelog: "Made on a Mac",
        dbChanging: false,
      })
      .expect(201);
    expect(await files("versions")).toEqual([`${check.body.sha256}.zip`]);
    const version = await db.pluginVersion.findFirstOrThrow();
    expect(version).toMatchObject({ sha256: check.body.sha256, sizeBytes: quarantined.length });
    const row = await db.auditLog.findFirstOrThrow({ where: { action: "plugin.upload.check" } });
    expect(row.meta).toMatchObject({
      sha256: check.body.sha256,
      uploadedSha256: check.body.uploadedSha256,
    });
  });

  it("still refuses a Finder ZIP with a link or '..' inside __MACOSX, and keeps nothing", async () => {
    const dev = await make("DEVELOPER");
    for (const entry of [
      { name: "__MACOSX/ulix-forms/._up", data: "../../..", unixMode: 0o120777 },
      { name: "__MACOSX/../../evil.php", data: "<?php system($_GET['c']);" },
    ]) {
      const res = await as(dev.token)
        .upload(finderZip([entry]))
        .expect(200);
      expect(res.body).toMatchObject({ ok: false, uploadId: null, notes: [] });
      expect(res.body.checks.at(-1)).toMatchObject({ name: "paths", ok: false });
    }
    expect(await files("uploads")).toEqual([]);
  });

  it("keeps nothing from a ZIP that fails a check, and audits the reason", async () => {
    const dev = await make("DEVELOPER");
    const evil = makeZip([
      { name: "ulix-forms/ulix-forms.php", data: "<?php /* Plugin Name: X\n Version: 1 */" },
      { name: "ulix-forms/../../../wp-config.php", data: "x" },
    ]);
    const res = await as(dev.token).upload(evil).expect(200);
    expect(res.body).toMatchObject({ ok: false, uploadId: null });
    expect(res.body.checks.at(-1)).toMatchObject({ name: "paths", ok: false });
    expect(await files("uploads")).toEqual([]);
    expect(await db.pluginUpload.count()).toBe(0);
    const row = await db.auditLog.findFirstOrThrow({ where: { action: "plugin.upload.check" } });
    expect(row).toMatchObject({ result: "failure", meta: { failed: "paths" } });
  });

  it("lets Viewers read the registry but not upload", async () => {
    const dev = await make("DEVELOPER");
    const viewer = await make("VIEWER");
    await publish(dev.token, pluginZip());
    await as(viewer.token)
      .upload(pluginZip({ version: "1.3.0" }))
      .expect(403);
    await as(viewer.token)
      .post("/plugins/versions", { uploadId: "x", changelog: "x", dbChanging: false })
      .expect(403);
    const list = await as(viewer.token).get("/plugins").expect(200);
    expect(list.body.plugins).toHaveLength(1);
    await as(viewer.token).get("/plugins/ulix-forms").expect(200);
    await as(viewer.token).get("/plugins/Not_A_Slug").expect(404);
    await as(viewer.token).get("/plugins/missing").expect(404);
  });

  it("refuses a version that is already in the registry and notes identical files", async () => {
    const dev = await make("DEVELOPER");
    await publish(dev.token, pluginZip());
    const again = await as(dev.token).upload(pluginZip()).expect(200);
    expect(again.body).toMatchObject({
      ok: false,
      uploadId: null,
      pluginExists: true,
      latestVersion: "1.2.0",
    });
    expect(again.body.checks.at(-1).detail).toMatch(/already in the registry/);
    expect(again.body.warnings).toContain("This file is identical to version 1.2.0.");
  });

  it("only saves the uploader's own, unexpired, untouched upload", async () => {
    const dev = await make("DEVELOPER");
    const other = await make("ADMIN", "other@example.test");
    const check = await as(dev.token).upload(pluginZip()).expect(200);
    const save = (token: string, uploadId = check.body.uploadId) =>
      as(token).post("/plugins/versions", { uploadId, changelog: "x", dbChanging: false });

    expect((await save(other.token).expect(410)).body).toEqual({ error: "upload_expired" });
    await save(dev.token, "doesnotexist").expect(410);

    // Someone changed the quarantined file on disk: refused, nothing saved.
    await writeFile(
      path.join(dir, "uploads", `${check.body.uploadId}.zip`),
      pluginZip({ version: "9.9.9" }),
    );
    expect((await save(dev.token).expect(422)).body).toEqual({ error: "upload_invalid" });
    expect(await db.pluginVersion.count()).toBe(0);

    const late = await as(dev.token)
      .upload(pluginZip({ version: "1.4.0" }))
      .expect(200);
    await db.pluginUpload.update({
      where: { id: late.body.uploadId },
      data: { expiresAt: new Date(NOW.getTime() - 1) },
    });
    await save(dev.token, late.body.uploadId).expect(410);
    // The next upload cleans expired ones away, files included.
    await as(dev.token)
      .upload(pluginZip({ version: "1.5.0" }))
      .expect(200);
    expect(existsSync(path.join(dir, "uploads", `${late.body.uploadId}.zip`))).toBe(false);
  });

  it("saves an upload once even when saved twice at the same time", async () => {
    const dev = await make("DEVELOPER");
    const check = await as(dev.token).upload(pluginZip()).expect(200);
    const save = () =>
      as(dev.token).post("/plugins/versions", {
        uploadId: check.body.uploadId,
        changelog: "x",
        dbChanging: false,
      });
    const statuses = (await Promise.all([save(), save()])).map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect([409, 410, 422]).toContain(statuses[1]);
    expect(await db.pluginVersion.count()).toBe(1);
  });

  it("rejects bodies that aren't a ZIP upload or are too large", async () => {
    const dev = await make("DEVELOPER");
    await as(dev.token).post("/plugins/uploads?filename=x.zip", { zip: "base64" }).expect(400);
    await as(dev.token).upload(pluginZip(), "").expect(400);
    await as(dev.token)
      .upload(Buffer.alloc(10 * 1024 * 1024 + 2))
      .expect(413);
    const res = await as(dev.token).upload(pluginZip(), "../../etc/passwd.zip").expect(200);
    expect(res.body.filename).toBe("passwd.zip");
  });

  it("shows which version each site runs against the highest uploaded version", async () => {
    const admin = await make("ADMIN");
    await publish(admin.token, pluginZip({ version: "1.3.0" }), "Newest");
    // Uploaded later but lower: "latest" is the highest version, not the newest upload.
    await publish(admin.token, pluginZip({ version: "1.2.5" }), "Hotfix for the old line");

    const site = async (
      name: string,
      version: string | null,
      opts: { archived?: boolean; inventory?: boolean; staging?: string | null } = {},
    ) => {
      const created = await db.site.create({
        data: {
          name,
          url: `https://${name.toLowerCase()}.example.test`,
          host: "WPENGINE",
          tags: [],
          archived: opts.archived ?? false,
          environments: {
            create: [
              {
                kind: "PRODUCTION",
                url: "https://x.test",
                sshHost: "h",
                sshUser: "u",
                wpPath: "/w",
                credentialRef: "KEY_A",
              },
              ...(opts.staging !== undefined
                ? [
                    {
                      kind: "STAGING" as const,
                      url: "https://s.test",
                      sshHost: "h",
                      sshUser: "u",
                      wpPath: "/w",
                      credentialRef: "KEY_A",
                    },
                  ]
                : []),
            ],
          },
        },
        include: { environments: true },
      });
      for (const env of created.environments) {
        const v = env.kind === "PRODUCTION" ? version : (opts.staging ?? null);
        if (opts.inventory === false) continue;
        await db.siteInventory.create({
          data: {
            environmentId: env.id,
            refreshedAt: NOW,
            wpVersion: "6.9",
            phpVersion: "8.3",
            wpCliVersion: "2.12.0",
            warnings: [],
            themes: [],
            plugins:
              v === null
                ? [
                    {
                      name: "akismet",
                      title: "Akismet",
                      status: "active",
                      version: "5.3",
                      updateVersion: null,
                    },
                  ]
                : [
                    {
                      name: "ulix-forms",
                      title: "Ulix Forms",
                      status: "active",
                      version: v,
                      updateVersion: null,
                    },
                  ],
          },
        });
      }
    };
    await site("Alpha", "1.3.0", { staging: "1.2.5" });
    await site("Bravo", "1.2.0");
    await site("Charlie", "2.0.0-dev");
    await site("Delta", null);
    await site("Echo", "1.0.0", { inventory: false });
    await site("Zulu", "1.0.0", { archived: true });

    const list = await as(admin.token).get("/plugins").expect(200);
    expect(list.body.plugins[0]).toMatchObject({
      slug: "ulix-forms",
      latestVersion: "1.3.0",
      versionCount: 2,
      production: { latest: 1, outdated: 1, newer: 1, notInstalled: 1, unknown: 1 },
    });

    const detail = await as(admin.token).get("/plugins/ulix-forms").expect(200);
    expect(detail.body.versions.map((v: { version: string }) => v.version)).toEqual([
      "1.3.0",
      "1.2.5",
    ]);
    expect(
      detail.body.sites.map(
        (r: {
          siteName: string;
          kind: string;
          status: string;
          installedVersion: string | null;
          registered: boolean;
        }) => [r.siteName, r.kind, r.status, r.installedVersion, r.registered],
      ),
    ).toEqual([
      ["Alpha", "PRODUCTION", "latest", "1.3.0", true],
      ["Alpha", "STAGING", "outdated", "1.2.5", true],
      ["Bravo", "PRODUCTION", "outdated", "1.2.0", false],
      ["Charlie", "PRODUCTION", "newer", "2.0.0-dev", false],
      ["Delta", "PRODUCTION", "not_installed", null, false],
      ["Echo", "PRODUCTION", "unknown", null, false],
    ]);
  });
});
