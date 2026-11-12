// Site file manager API (A179): browse and mutate under wpPath over the runner's SFTP.
import { randomUUID } from "node:crypto";
import {
  FILES_MAX_BYTES,
  FilesDeleteBody,
  FilesMkdirBody,
  FilesRenameBody,
  FilesSftpConnectionUpdate,
  FilesSftpConnectionView,
  filesSftpPasswordRefFor,
  FilesWriteBody,
  HostKeyFingerprint,
  RecordId,
  RelPath,
  SealKeyResult,
  SecretSetResult,
  SITE_JOB_STALE_MS,
  SiteFilesListResult,
  SiteFilesMutateResult,
  SiteFilesReadResult,
  type SiteFilesOp as FilesOp,
} from "@ulixops/shared";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit";
import { sealTo } from "../credentials/api-keys";
import type { Db } from "../db";
import { Prisma } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";
import { callRunner } from "./routes";

export interface SiteFilesDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
}

const Kind = z
  .enum(["production", "staging"])
  .transform((k) => k.toUpperCase() as "PRODUCTION" | "STAGING");

const JOB_TIMEOUT_MS = 120_000;

const ListJob = z.intersection(
  z.object({ hostKeyMismatch: z.literal(false), kind: z.literal("list") }),
  SiteFilesListResult,
);
const ReadJob = z.intersection(
  z.object({ hostKeyMismatch: z.literal(false), kind: z.literal("read") }),
  SiteFilesReadResult,
);
const MutateJob = z.intersection(
  z.object({ hostKeyMismatch: z.literal(false), kind: z.literal("mutate") }),
  SiteFilesMutateResult,
);
const Mismatch = z.object({
  hostKeyMismatch: z.literal(true),
  expected: z.string(),
  presented: z.string(),
});

function filesTargetOf(env: {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  wpPath: string;
  credentialRef: string;
  hostKey: string | null;
  filesSftpHost: string | null;
  filesSftpPort: number | null;
  filesSftpUser: string | null;
  filesSftpPath: string | null;
  filesSftpCredentialRef: string | null;
  filesSftpAuthKind: string | null;
  filesSftpHostKey: string | null;
}) {
  if (env.filesSftpHost && env.filesSftpUser && env.filesSftpPath) {
    const passwordAuth = env.filesSftpAuthKind === "password";
    return {
      host: env.filesSftpHost,
      port: env.filesSftpPort ?? 2222,
      user: env.filesSftpUser,
      wpPath: env.filesSftpPath,
      credentialRef: env.filesSftpCredentialRef || env.credentialRef,
      hostKey: env.filesSftpHostKey,
      nativeSftpOnly: true as const,
      ...(passwordAuth ? { authMode: "password" as const } : {}),
    };
  }
  return {
    host: env.sshHost,
    port: env.sshPort,
    user: env.sshUser,
    wpPath: env.wpPath,
    credentialRef: env.credentialRef,
    hostKey: env.hostKey,
  };
}

function sftpView(env: {
  filesSftpHost: string | null;
  filesSftpPort: number | null;
  filesSftpUser: string | null;
  filesSftpPath: string | null;
  filesSftpCredentialRef: string | null;
  filesSftpAuthKind: string | null;
  filesSftpHostKey: string | null;
}): z.infer<typeof FilesSftpConnectionView> {
  const authKind = env.filesSftpAuthKind === "password" ? "password" : "key";
  return {
    enabled: Boolean(env.filesSftpHost && env.filesSftpUser && env.filesSftpPath),
    host: env.filesSftpHost,
    port: env.filesSftpPort,
    user: env.filesSftpUser,
    path: env.filesSftpPath,
    authKind,
    credentialRef: authKind === "key" ? env.filesSftpCredentialRef : null,
    passwordSet: authKind === "password" && Boolean(env.filesSftpCredentialRef),
    hostKeyPinned: Boolean(env.filesSftpHostKey),
  };
}

async function claim(db: Db, environmentId: string, now: () => Date): Promise<string | null> {
  const token = randomUUID();
  const at = now();
  try {
    await db.siteEnvironmentLock.create({ data: { environmentId, token, lockedAt: at } });
    return token;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
      throw error;
  }
  const taken = await db.siteEnvironmentLock.updateMany({
    where: { environmentId, lockedAt: { lt: new Date(at.getTime() - SITE_JOB_STALE_MS) } },
    data: { token, lockedAt: at },
  });
  return taken.count === 1 ? token : null;
}

const release = (db: Db, environmentId: string, token: string) =>
  db.siteEnvironmentLock.deleteMany({ where: { environmentId, token } });

/** Mounted on /sites — paths like /:id/environments/:kind/files. */
export function siteFilesRouter(deps: SiteFilesDeps): Router {
  const { db, now, runner } = deps;
  const router = Router();

  const envOf = async (siteId: unknown, kind: unknown) => {
    const id = RecordId.safeParse(siteId);
    const k = Kind.safeParse(kind ?? "production");
    if (!id.success || !k.success) return null;
    return db.siteEnvironment.findUnique({
      where: { siteId_kind: { siteId: id.data, kind: k.data } },
      include: { site: { select: { id: true, name: true, archived: true } } },
    });
  };

  async function runOp(
    env: NonNullable<Awaited<ReturnType<typeof envOf>>>,
    op: FilesOp,
    mutate: boolean,
    userId: string,
    ip: string | null,
  ): Promise<
    { ok: true; body: unknown } | { ok: false; status: number; error: string; detail?: string }
  > {
    if (env.site.archived) return { ok: false, status: 409, error: "site_archived" };
    const usingFilesSftp = Boolean(
      env.filesSftpHost && env.filesSftpUser && env.filesSftpPath,
    );
    // Dedicated SFTP can TOFU its own host key; SSH path still needs a tested site connection.
    if (!usingFilesSftp && !env.hostKey)
      return { ok: false, status: 409, error: "connection_untested" };

    let token: string | null = null;
    if (mutate) {
      token = await claim(db, env.id, now);
      if (!token) return { ok: false, status: 409, error: "environment_busy" };
    }

    const action =
      op.kind === "list"
        ? "site.files.list"
        : op.kind === "read"
          ? "site.files.read"
          : op.kind === "write"
            ? "site.files.write"
            : op.kind === "mkdir"
              ? "site.files.mkdir"
              : op.kind === "delete"
                ? "site.files.delete"
                : "site.files.rename";

    const metaPath =
      op.kind === "rename" ? { from: op.from, to: op.to } : { path: "path" in op ? op.path : "" };

    try {
      let raw: unknown;
      try {
        const target = filesTargetOf(env);
        raw = await runner.run({ type: "site.files", target, op }, JOB_TIMEOUT_MS);
        // Pin dedicated SFTP host key on first successful use (TOFU).
        if (
          usingFilesSftp &&
          !env.filesSftpHostKey &&
          typeof raw === "object" &&
          raw &&
          "hostKey" in raw &&
          typeof (raw as { hostKey?: unknown }).hostKey === "string"
        ) {
          const pinned = HostKeyFingerprint.safeParse((raw as { hostKey: string }).hostKey);
          if (pinned.success) {
            await db.siteEnvironment.update({
              where: { id: env.id },
              data: { filesSftpHostKey: pinned.data },
            });
            env.filesSftpHostKey = pinned.data;
          }
        }
      } catch (error) {
        if (error instanceof RunnerUnavailableError)
          return { ok: false, status: 504, error: "runner_unavailable" };
        if (error instanceof RunnerJobFailedError)
          return { ok: false, status: 502, error: "runner_failed", detail: error.message };
        throw error;
      }

      if (Mismatch.safeParse(raw).success) {
        if (mutate)
          await audit(
            db,
            {
              userId,
              action,
              result: "failure",
              ip,
              siteIds: [env.site.id],
              meta: { kind: env.kind, ...metaPath, reason: "host_key_mismatch" },
            },
            now(),
          );
        return { ok: false, status: 409, error: "host_key_mismatch" };
      }

      if (op.kind === "list") {
        const parsed = ListJob.safeParse(raw);
        if (parsed.success) {
          const { hostKeyMismatch: _, kind: __, ...rest } = parsed.data;
          return { ok: true, body: { ok: true as const, ...rest } };
        }
        const failed = MutateJob.safeParse(raw);
        if (failed.success && !failed.data.ok) {
          const { hostKeyMismatch: _, kind: __, ...body } = failed.data;
          return { ok: true, body };
        }
        return { ok: false, status: 502, error: "runner_failed", detail: "Unexpected answer." };
      }
      if (op.kind === "read") {
        const parsed = ReadJob.safeParse(raw);
        if (parsed.success) {
          const { hostKeyMismatch: _, kind: __, ...rest } = parsed.data;
          return { ok: true, body: { ok: true as const, ...rest } };
        }
        const failed = MutateJob.safeParse(raw);
        if (failed.success && !failed.data.ok) {
          const { hostKeyMismatch: _, kind: __, ...body } = failed.data;
          return { ok: true, body };
        }
        return { ok: false, status: 502, error: "runner_failed", detail: "Unexpected answer." };
      }

      const parsed = MutateJob.safeParse(raw);
      if (!parsed.success)
        return { ok: false, status: 502, error: "runner_failed", detail: "Unexpected answer." };
      const result = parsed.data;
      await audit(
        db,
        {
          userId,
          action,
          result: result.ok ? "success" : "failure",
          ip,
          siteIds: [env.site.id],
          meta: {
            kind: env.kind,
            ...metaPath,
            bytes: result.ok ? result.bytes : undefined,
            detail: result.ok ? undefined : result.detail.slice(0, 200),
          },
        },
        now(),
      );
      const { hostKeyMismatch: _, kind: __, ...body } = result;
      return { ok: true, body };
    } finally {
      if (token) await release(db, env.id, token);
    }
  }

  router.get(
    "/:id/environments/:kind/files",
    authorize("sites.refresh", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const path = RelPath.safeParse(typeof req.query.path === "string" ? req.query.path : "");
      if (!path.success) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      const user = sessionOf(req).user;
      const ran = await callRunner(res, () =>
        runOp(env, { kind: "list", path: path.data }, false, user.id, clientIpOf(req)),
      );
      if (!ran) return;
      if (!ran.ok) {
        res.status(ran.status).json({ error: ran.error, detail: ran.detail });
        return;
      }
      res.json(ran.body);
    },
  );

  router.get(
    "/:id/environments/:kind/files/content",
    authorize("sites.refresh", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const path = RelPath.safeParse(typeof req.query.path === "string" ? req.query.path : "");
      if (!path.success || !path.data) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      const user = sessionOf(req).user;
      const ran = await callRunner(res, () =>
        runOp(env, { kind: "read", path: path.data }, false, user.id, clientIpOf(req)),
      );
      if (!ran) return;
      if (!ran.ok) {
        res.status(ran.status).json({ error: ran.error, detail: ran.detail });
        return;
      }
      res.json(ran.body);
    },
  );

  router.put(
    "/:id/environments/:kind/files/content",
    authorize("sites.manage", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const body = FilesWriteBody.safeParse(req.body);
      if (!body.success || !body.data.path) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      let contentBase64: string;
      if (body.data.encoding === "base64") {
        contentBase64 = body.data.content;
        try {
          if (Buffer.from(contentBase64, "base64").length > FILES_MAX_BYTES) {
            res.status(400).json({ error: "bad_request", detail: "File too large." });
            return;
          }
        } catch {
          res.status(400).json({ error: "bad_request" });
          return;
        }
      } else {
        const buf = Buffer.from(body.data.content, "utf8");
        if (buf.length > FILES_MAX_BYTES) {
          res.status(400).json({ error: "bad_request", detail: "File too large." });
          return;
        }
        contentBase64 = buf.toString("base64");
      }
      const user = sessionOf(req).user;
      const ran = await callRunner(res, () =>
        runOp(
          env,
          { kind: "write", path: body.data.path, contentBase64 },
          true,
          user.id,
          clientIpOf(req),
        ),
      );
      if (!ran) return;
      if (!ran.ok) {
        res.status(ran.status).json({ error: ran.error, detail: ran.detail });
        return;
      }
      res.json(ran.body);
    },
  );

  router.post(
    "/:id/environments/:kind/files/mkdir",
    authorize("sites.manage", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const body = FilesMkdirBody.safeParse(req.body);
      if (!body.success || !body.data.path) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      const user = sessionOf(req).user;
      const ran = await callRunner(res, () =>
        runOp(env, { kind: "mkdir", path: body.data.path }, true, user.id, clientIpOf(req)),
      );
      if (!ran) return;
      if (!ran.ok) {
        res.status(ran.status).json({ error: ran.error, detail: ran.detail });
        return;
      }
      res.json(ran.body);
    },
  );

  router.post(
    "/:id/environments/:kind/files/rename",
    authorize("sites.manage", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const body = FilesRenameBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      const user = sessionOf(req).user;
      const ran = await callRunner(res, () =>
        runOp(
          env,
          { kind: "rename", from: body.data.from, to: body.data.to },
          true,
          user.id,
          clientIpOf(req),
        ),
      );
      if (!ran) return;
      if (!ran.ok) {
        res.status(ran.status).json({ error: ran.error, detail: ran.detail });
        return;
      }
      res.json(ran.body);
    },
  );

  router.post(
    "/:id/environments/:kind/files/delete",
    authorize("sites.manage", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const body = FilesDeleteBody.safeParse(req.body);
      if (!body.success || !body.data.path) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      const user = sessionOf(req).user;
      const ran = await callRunner(res, () =>
        runOp(
          env,
          { kind: "delete", path: body.data.path, recursive: body.data.recursive },
          true,
          user.id,
          clientIpOf(req),
        ),
      );
      if (!ran) return;
      if (!ran.ok) {
        res.status(ran.status).json({ error: ran.error, detail: ran.detail });
        return;
      }
      res.json(ran.body);
    },
  );

  router.get(
    "/:id/environments/:kind/files/sftp",
    authorize("sites.refresh", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(sftpView(env));
    },
  );

  router.put(
    "/:id/environments/:kind/files/sftp",
    authorize("sites.manage", deps),
    async (req, res) => {
      const env = await envOf(req.params.id, req.params.kind);
      if (!env) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (env.site.archived) {
        res.status(409).json({ error: "site_archived" });
        return;
      }
      const body = FilesSftpConnectionUpdate.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      const user = sessionOf(req).user;
      const ip = clientIpOf(req);
      if (body.data === null) {
        const updated = await db.siteEnvironment.update({
          where: { id: env.id },
          data: {
            filesSftpHost: null,
            filesSftpPort: null,
            filesSftpUser: null,
            filesSftpPath: null,
            filesSftpCredentialRef: null,
            filesSftpAuthKind: null,
            filesSftpHostKey: null,
          },
        });
        await audit(
          db,
          {
            userId: user.id,
            action: "site.files.sftp.clear",
            result: "success",
            ip,
            siteIds: [env.site.id],
            meta: { kind: env.kind },
          },
          now(),
        );
        res.json(sftpView(updated));
        return;
      }
      const next = body.data;
      const hostChanged =
        next.host !== env.filesSftpHost ||
        next.port !== (env.filesSftpPort ?? 2222) ||
        next.user !== env.filesSftpUser;

      let credentialRef: string;
      let authKind: "key" | "password";
      if (next.authKind === "key") {
        authKind = "key";
        credentialRef = next.credentialRef;
      } else {
        authKind = "password";
        credentialRef = filesSftpPasswordRefFor(env.id);
        const alreadySet =
          env.filesSftpAuthKind === "password" && env.filesSftpCredentialRef === credentialRef;
        if (!next.password && !alreadySet) {
          res.status(400).json({ error: "bad_request" });
          return;
        }
        if (next.password) {
          const pub = await callRunner(res, () => deps.runner.run({ type: "secrets.publicKey" }));
          if (pub === null) return;
          const { keyId, publicKey } = SealKeyResult.parse(pub);
          const raw = await callRunner(res, () =>
            deps.runner.run({
              type: "secrets.setFilesSftpPassword",
              name: credentialRef,
              keyId,
              ciphertext: sealTo(publicKey, next.password!),
            }),
          );
          if (raw === null) return;
          const stored = SecretSetResult.safeParse(raw);
          if (!stored.success || !stored.data.ok) {
            res.status(502).json({ error: "runner_failed" });
            return;
          }
        }
      }

      const updated = await db.siteEnvironment.update({
        where: { id: env.id },
        data: {
          filesSftpHost: next.host,
          filesSftpPort: next.port,
          filesSftpUser: next.user,
          filesSftpPath: next.path,
          filesSftpCredentialRef: credentialRef,
          filesSftpAuthKind: authKind,
          // New endpoint → re-pin on next successful list.
          ...(hostChanged ? { filesSftpHostKey: null } : {}),
        },
      });
      await audit(
        db,
        {
          userId: user.id,
          action: "site.files.sftp.save",
          result: "success",
          ip,
          siteIds: [env.site.id],
          meta: {
            kind: env.kind,
            host: next.host,
            port: next.port,
            user: next.user,
            path: next.path,
            authKind,
            // Never audit the password. Key mode may record the vault key name only.
            credentialRef: authKind === "key" ? credentialRef : undefined,
            passwordRotated: authKind === "password" && Boolean(next.authKind === "password" && next.password),
          },
        },
        now(),
      );
      res.json(sftpView(updated));
    },
  );

  return router;
}
