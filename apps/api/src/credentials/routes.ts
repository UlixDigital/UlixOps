// Vault credentials (spec 5: SSH keys in the vault, rotation reminders). The API never sees a
// key: the runner lists names and dates, and creates keys whose private half never leaves it.
import {
  CreateCredentialRequest,
  CredentialCreatedResult,
  CredentialsListResult,
  type CredentialView,
  ROTATION_DAYS,
} from "@ulixops/shared";
import { Router } from "express";
import { audit } from "../audit";
import type { Db } from "../db";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import type { RunnerClient } from "../runner/client";
import { callRunner } from "../sites/routes";

const DAY_MS = 24 * 60 * 60 * 1000;

export function credentialsRouter(deps: { db: Db; now: () => Date; runner: RunnerClient }): Router {
  const { db, now } = deps;
  const router = Router();
  router.use(authorize("secrets.manage", deps));

  router.get("/", async (_req, res) => {
    // Listing is quick; a page waiting on it should fail fast if the runner is down.
    const raw = await callRunner(res, () => deps.runner.run({ type: "credentials.list" }, 10_000));
    if (raw === null) return;
    const { credentials } = CredentialsListResult.parse(raw);
    const envs = await db.siteEnvironment.findMany({
      where: { credentialRef: { in: credentials.map((c) => c.name) } },
      select: { credentialRef: true, kind: true, site: { select: { id: true, name: true } } },
    });
    const views: CredentialView[] = credentials.map((c) => {
      const ageDays = Math.floor((now().getTime() - new Date(c.createdAt).getTime()) / DAY_MS);
      return {
        ...c,
        ageDays,
        rotationDue: ageDays >= ROTATION_DAYS,
        usedBy: envs
          .filter((e) => e.credentialRef === c.name)
          .map((e) => ({ siteId: e.site.id, siteName: e.site.name, kind: e.kind })),
      };
    });
    res.json({ credentials: views });
  });

  router.post("/", async (req, res) => {
    const body = CreateCredentialRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    let taken = false;
    const raw = await callRunner(res, async () => {
      try {
        return await deps.runner.run({ type: "credentials.create", name: body.data.name });
      } catch (error) {
        if (error instanceof Error && /already exists/.test(error.message)) {
          taken = true;
          return null;
        }
        throw error;
      }
    });
    if (taken) {
      res.status(409).json({ error: "name_taken" });
      return;
    }
    if (raw === null) return;
    const created = CredentialCreatedResult.parse(raw);
    await audit(
      db,
      {
        userId: sessionOf(req).user.id,
        action: "credential.create",
        result: "success",
        ip: clientIpOf(req),
        meta: { name: created.name },
      },
      now(),
    );
    res.status(201).json(created);
  });

  return router;
}
