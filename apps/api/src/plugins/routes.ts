// Custom plugin registry (spec 6.3, screens 6-8): checked ZIP uploads, versions with changelog
// and checksum, and which version each site runs (from the step 6 inventories).
import {
  compareVersions,
  CreatePluginVersionRequest,
  type InstallStatus,
  MAX_PLUGIN_ZIP_BYTES,
  PLUGIN_UPLOAD_TTL_MS,
  type PluginDetail,
  type PluginSummary,
  type PluginUploadResult,
  slug as Slug,
  type SitePluginRow,
} from "@ulixops/shared";
import express, { type Request, Router } from "express";
import { z } from "zod";
import { audit } from "../audit";
import type { Db } from "../db";
import { Prisma, type Plugin, type PluginVersion } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { items } from "../sites/operations";
import type { PluginStore } from "./store";
import { checkPluginZip } from "./validate";

export interface PluginsDeps {
  db: Db;
  now: () => Date;
  store: PluginStore;
}

/** Shown and audited only; never used as a path (files are named by id and checksum). */
const Filename = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((name) => (name.split(/[\\/]/).pop() ?? "").replace(/[^\w .()+-]/g, "_"));

type WithVersions = Plugin & { versions: PluginVersion[] };

/** Highest version first (agent decision A64: "latest" means the highest version number). */
const byVersionDesc = (a: PluginVersion, b: PluginVersion) =>
  compareVersions(b.version, a.version) || b.createdAt.getTime() - a.createdAt.getTime();

export function pluginsRouter(deps: PluginsDeps): Router {
  const { db, now, store } = deps;
  const router = Router();
  const canView = authorize("plugins.view", deps);
  const canUpload = authorize("plugins.upload", deps);

  const record = (req: Request, action: string, result: string, meta: Prisma.InputJsonObject) =>
    audit(db, { userId: sessionOf(req).user.id, action, result, ip: clientIpOf(req), meta }, now());

  /** Every environment of every active site, with where it stands for each plugin slug. */
  async function installs(plugins: WithVersions[]): Promise<Map<string, SitePluginRow[]>> {
    const sites = await db.site.findMany({
      where: { archived: false },
      orderBy: { name: "asc" },
      include: { environments: { orderBy: { kind: "asc" }, include: { inventory: true } } },
    });
    const rows = new Map<string, SitePluginRow[]>();
    for (const plugin of plugins) {
      const known = new Set(plugin.versions.map((v) => v.version));
      const latest = [...plugin.versions].sort(byVersionDesc)[0]?.version ?? null;
      rows.set(
        plugin.slug,
        sites.flatMap((site) =>
          site.environments.map((env): SitePluginRow => {
            const found = env.inventory
              ? items(env.inventory.plugins).find((p) => p.name === plugin.slug)
              : undefined;
            const installed = found?.version || null;
            let status: InstallStatus = "unknown";
            if (env.inventory) {
              if (!found) status = "not_installed";
              else if (!installed || !latest) status = "outdated";
              else {
                const order = compareVersions(installed, latest);
                status = order === 0 ? "latest" : order < 0 ? "outdated" : "newer";
              }
            }
            return {
              siteId: site.id,
              siteName: site.name,
              kind: env.kind,
              status,
              installedVersion: installed,
              active: found ? found.status === "active" || found.status === "active-network" : null,
              registered: installed !== null && known.has(installed),
              inventoryAt: env.inventory?.refreshedAt.toISOString() ?? null,
            };
          }),
        ),
      );
    }
    return rows;
  }

  function summary(plugin: WithVersions, rows: SitePluginRow[]): PluginSummary {
    const latest = [...plugin.versions].sort(byVersionDesc)[0];
    const production = rows.filter((r) => r.kind === "PRODUCTION");
    const count = (status: InstallStatus) => production.filter((r) => r.status === status).length;
    return {
      slug: plugin.slug,
      name: plugin.name,
      latestVersion: latest?.version ?? null,
      latestAt: latest?.createdAt.toISOString() ?? null,
      versionCount: plugin.versions.length,
      production: {
        latest: count("latest"),
        outdated: count("outdated"),
        newer: count("newer"),
        notInstalled: count("not_installed"),
        unknown: count("unknown"),
      },
    };
  }

  router.get("/", canView, async (_req, res) => {
    const plugins = await db.plugin.findMany({
      include: { versions: true },
      orderBy: { name: "asc" },
    });
    const rows = await installs(plugins);
    res.json({ plugins: plugins.map((p) => summary(p, rows.get(p.slug) ?? [])) });
  });

  router.get("/:slug", canView, async (req, res) => {
    const slug = Slug.safeParse(req.params.slug);
    const plugin = slug.success
      ? await db.plugin.findUnique({ where: { slug: slug.data }, include: { versions: true } })
      : null;
    if (!plugin) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rows = (await installs([plugin])).get(plugin.slug) ?? [];
    const uploaders = [
      ...new Set(plugin.versions.flatMap((v) => (v.uploadedById ? [v.uploadedById] : []))),
    ];
    const users = new Map(
      (
        await db.user.findMany({
          where: { id: { in: uploaders } },
          select: { id: true, email: true },
        })
      ).map((u) => [u.id, u]),
    );
    const detail: PluginDetail = {
      ...summary(plugin, rows),
      versions: [...plugin.versions].sort(byVersionDesc).map((v) => ({
        version: v.version,
        sha256: v.sha256,
        sizeBytes: v.sizeBytes,
        changelog: v.changelog,
        dbChanging: v.dbChanging,
        requiresWp: v.requiresWp,
        requiresPhp: v.requiresPhp,
        createdAt: v.createdAt.toISOString(),
        uploadedBy: v.uploadedById ? (users.get(v.uploadedById) ?? null) : null,
      })),
      sites: rows,
    };
    res.json(detail);
  });

  /** Drops quarantined uploads nobody saved in time (rows and files). */
  async function dropExpired() {
    const expired = await db.pluginUpload.findMany({
      where: { expiresAt: { lte: now() } },
      select: { id: true },
      take: 100,
    });
    for (const { id } of expired) await store.removeUpload(id);
    if (expired.length > 0)
      await db.pluginUpload.deleteMany({ where: { id: { in: expired.map((u) => u.id) } } });
  }

  // Step 1 (screen 7): the ZIP as a raw application/zip body, checked before anything is kept.
  router.post(
    "/uploads",
    canUpload,
    express.raw({ type: "application/zip", limit: MAX_PLUGIN_ZIP_BYTES + 1 }),
    async (req, res) => {
      const filename = Filename.safeParse(req.query.filename);
      if (!filename.success || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      await dropExpired();
      const body: Buffer = req.body;
      const { zip, ...check } = checkPluginZip(body, filename.data);
      const existing = check.slug
        ? await db.plugin.findUnique({ where: { slug: check.slug }, include: { versions: true } })
        : null;
      const result: PluginUploadResult = {
        ...check,
        uploadId: null,
        filename: filename.data,
        pluginExists: existing !== null,
        latestVersion: existing
          ? ([...existing.versions].sort(byVersionDesc)[0]?.version ?? null)
          : null,
      };
      if (check.ok && existing && check.version) {
        if (existing.versions.some((v) => v.version === check.version)) {
          result.ok = false;
          result.checks.push({
            name: "plugin",
            ok: false,
            detail: `Version ${check.version} of ${existing.slug} is already in the registry. Raise the Version header for a new release.`,
          });
        }
        const same = existing.versions.find((v) => v.sha256 === check.sha256);
        if (same) result.warnings.push(`This file is identical to version ${same.version}.`);
      }

      if (result.ok && check.slug && check.name && check.version) {
        const upload = await db.pluginUpload.create({
          data: {
            sha256: check.sha256,
            sizeBytes: check.sizeBytes,
            filename: filename.data,
            slug: check.slug,
            name: check.name,
            version: check.version,
            requiresWp: check.requiresWp,
            requiresPhp: check.requiresPhp,
            uploadedById: sessionOf(req).user.id,
            expiresAt: new Date(now().getTime() + PLUGIN_UPLOAD_TTL_MS),
          },
        });
        // The checked bytes: without macOS metadata when there was some (agent decision A66).
        await store.saveUpload(upload.id, zip);
        result.uploadId = upload.id;
      }
      const failed = result.checks.find((c) => !c.ok);
      await record(req, "plugin.upload.check", result.ok ? "success" : "failure", {
        filename: filename.data,
        sha256: check.sha256,
        ...(check.uploadedSha256 ? { uploadedSha256: check.uploadedSha256 } : {}),
        sizeBytes: check.sizeBytes,
        slug: check.slug,
        version: check.version,
        ...(failed ? { failed: failed.name, reason: failed.detail } : {}),
        warnings: result.warnings.length,
      });
      res.json(result);
    },
  );

  // Step 2: the uploader adds the changelog and the "changes database" flag, then it's saved.
  router.post("/versions", canUpload, async (req, res) => {
    const body = CreatePluginVersionRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const userId = sessionOf(req).user.id;
    const upload = await db.pluginUpload.findUnique({ where: { id: body.data.uploadId } });
    if (!upload || upload.uploadedById !== userId || upload.expiresAt <= now()) {
      res.status(410).json({ error: "upload_expired" });
      return;
    }
    const data = await store.readUpload(upload.id);
    // Checked again from the quarantined bytes: the version saved is exactly what passed.
    const check = data ? checkPluginZip(data, upload.filename) : null;
    if (!data || !check?.ok || check.sha256 !== upload.sha256 || check.version !== upload.version) {
      await record(req, "plugin.version.create", "failure", {
        uploadId: upload.id,
        reason: "upload_invalid",
      });
      res.status(422).json({ error: "upload_invalid" });
      return;
    }

    const { storageKey } = await store.saveVersion(data);
    try {
      await db.$transaction(async (tx) => {
        const plugin = await tx.plugin.upsert({
          where: { slug: upload.slug },
          create: { slug: upload.slug, name: upload.name },
          update: { name: upload.name },
        });
        await tx.pluginVersion.create({
          data: {
            pluginId: plugin.id,
            version: upload.version,
            sha256: upload.sha256,
            storageKey,
            sizeBytes: upload.sizeBytes,
            changelog: body.data.changelog,
            dbChanging: body.data.dbChanging,
            requiresWp: upload.requiresWp,
            requiresPhp: upload.requiresPhp,
            uploadedById: userId,
            createdAt: now(),
          },
        });
        await tx.pluginUpload.delete({ where: { id: upload.id } });
      });
    } catch (error) {
      // Saved twice at once, or the version arrived from another upload meanwhile.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2025"].includes(error.code)
      ) {
        res.status(409).json({ error: "version_exists" });
        return;
      }
      throw error;
    }
    await store.removeUpload(upload.id);
    await record(req, "plugin.version.create", "success", {
      slug: upload.slug,
      version: upload.version,
      sha256: upload.sha256,
      dbChanging: body.data.dbChanging,
    });
    res.status(201).json({ slug: upload.slug, version: upload.version });
  });

  return router;
}
