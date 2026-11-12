// Integration API keys entered in Settings → Credentials (A133). A second Admin approves first;
// then the requester has 24 hours to enter the key once. The value is sealed to the runner's
// in-memory public key here, so only ciphertext goes on the queue, and it is stored only in
// the vault. It is never logged, audited, stored in Postgres, or returned.
import { constants, publicEncrypt } from "node:crypto";
import {
  API_KEY_WINDOW_MS,
  ApiKeyName,
  type ApiKeyStatus,
  apiKeyValueFor,
  CredentialsListResult,
  RecordId,
  SealKeyResult,
  SecretSetResult,
  SetApiKeyRequest,
  WORDFENCE_KEY_REF,
  CLOUDFLARE_TOKEN_REF,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import { requestApproval, selfApproveIfAllowed } from "../approvals/routes";
import { audit } from "../audit";
import { syncDns } from "../dns/service";
import type { Db } from "../db";
import type { ApprovalRequest, Prisma } from "../generated/prisma/client";
import { clientIpOf, sessionOf } from "../http/guard";
import type { SecurityNotifier } from "../notify";
import type { RunnerClient } from "../runner/client";
import { callRunner } from "../sites/routes";
import { isSyncing, readFeedStatus, syncVulnerabilities } from "../vulnerabilities/service";

export interface ApiKeyDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier?: SecurityNotifier;
}

const ACTION = "apikey.set";

// Approvals being used right now (one API process), so one approval can't be used twice at once.
const inFlight = new Set<string>();

function payloadOf(row: ApprovalRequest): { kind?: unknown; usedAt?: unknown } {
  return (row.payload ?? {}) as { kind?: unknown; usedAt?: unknown };
}

/** An approved, unused request still inside its window. */
function usable(row: ApprovalRequest, at: Date): boolean {
  return (
    row.status === "APPROVED" &&
    payloadOf(row).usedAt === undefined &&
    row.decidedAt !== null &&
    at.getTime() - row.decidedAt.getTime() < API_KEY_WINDOW_MS
  );
}

/** Seal a value to the runner's current public key (RSA-OAEP, SHA-256). */
export function sealTo(publicKey: string, value: string): string {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(value, "utf8"),
  ).toString("base64");
}

export function apiKeysRouter(deps: ApiKeyDeps): Router {
  const { db, now } = deps;
  const router = Router();

  function nameOf(req: Request, res: Response): ApiKeyName | null {
    const name = ApiKeyName.safeParse(String(req.params.name ?? "").toUpperCase());
    if (!name.success) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return name.data;
  }

  async function openRequest(name: ApiKeyName, at: Date) {
    const rows = await db.approvalRequest.findMany({
      where: {
        action: ACTION,
        status: { in: ["PENDING", "APPROVED"] },
        payload: { path: ["kind"], equals: name },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return rows.find((r) => r.status === "PENDING" || usable(r, at)) ?? null;
  }

  router.get("/:name", async (req, res) => {
    const name = nameOf(req, res);
    if (!name) return;
    const at = now();
    let setAt: string | null = null;
    let vaultReachable = true;
    try {
      const raw = await deps.runner.run({ type: "credentials.list" }, 10_000);
      setAt =
        CredentialsListResult.parse(raw).credentials.find((c) => c.name === name)?.updatedAt ??
        null;
    } catch {
      vaultReachable = false;
    }
    const open = await openRequest(name, at);
    const requester = open
      ? await db.user.findUnique({ where: { id: open.requestedById }, select: { email: true } })
      : null;
    const body: ApiKeyStatus = {
      name,
      setAt,
      vaultReachable,
      request: open
        ? {
            id: open.id,
            status: open.status === "APPROVED" ? "APPROVED" : "PENDING",
            ownRequest: open.requestedById === sessionOf(req).user.id,
            requestedBy: requester?.email ?? null,
            usableUntil:
              open.status === "APPROVED" && open.decidedAt
                ? new Date(open.decidedAt.getTime() + API_KEY_WINDOW_MS).toISOString()
                : null,
          }
        : null,
    };
    res.json(body);
  });

  router.post("/:name/request", async (req, res) => {
    const name = nameOf(req, res);
    if (!name) return;
    const at = now();
    // Only one open request per key: pending, or approved and not yet used.
    if (await openRequest(name, at)) {
      res.status(409).json({ error: "already_pending" });
      return;
    }
    const { user } = sessionOf(req);
    const result = await requestApproval(
      db,
      {
        action: ACTION,
        payload: { siteId: "", kind: name },
        requestedById: user.id,
        ip: clientIpOf(req),
        requesterRole: user.role,
      },
      at,
      deps.notifier,
    );
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    // A Super Admin approves their own request and can enter the key straight away (A134).
    const selfApproved = await selfApproveIfAllowed(
      { db, now, notifier: deps.notifier },
      result.id,
      user,
      clientIpOf(req),
    );
    res.status(201).json({ id: result.id, selfApproved });
  });

  router.put("/:name", async (req, res) => {
    const name = nameOf(req, res);
    if (!name) return;
    const body = SetApiKeyRequest.safeParse(req.body);
    const valueBad = !apiKeyValueFor(name).safeParse((req.body as { value?: unknown })?.value)
      .success;
    if (!body.success || valueBad) {
      // Don't say what was wrong with the value: it holds a secret.
      res.status(400).json({ error: valueBad ? "invalid_key" : "bad_request" });
      return;
    }
    const { user } = sessionOf(req);
    const ip = clientIpOf(req);
    const at = now();
    const approvalId = RecordId.parse(body.data.approvalId);
    const approval = await db.approvalRequest.findUnique({ where: { id: approvalId } });
    const record = (result: string, meta: Prisma.InputJsonObject = {}) =>
      audit(
        db,
        {
          userId: user.id,
          action: "credential.apikey.set",
          result,
          ip,
          meta: { name, requestId: approvalId, ...meta },
        },
        now(),
      );
    if (
      !approval ||
      approval.action !== ACTION ||
      payloadOf(approval).kind !== name ||
      approval.requestedById !== user.id ||
      !usable(approval, at) ||
      inFlight.has(approval.id)
    ) {
      await record("denied", { reason: "no usable approval" });
      res.status(409).json({ error: "approval_required" });
      return;
    }

    inFlight.add(approval.id);
    try {
      const pub = await callRunner(res, () => deps.runner.run({ type: "secrets.publicKey" }));
      if (pub === null) return;
      const { keyId, publicKey } = SealKeyResult.parse(pub);
      const raw = await callRunner(res, () =>
        deps.runner.run({
          type: "secrets.set",
          name,
          keyId,
          ciphertext: sealTo(publicKey, body.data.value),
        }),
      );
      if (raw === null) return;
      const result = SecretSetResult.parse(raw);
      if (!result.ok) {
        await record("failure", { reason: result.reason });
        const error = result.reason === "invalid" ? "invalid_key" : "vault_unavailable";
        res.status(error === "invalid_key" ? 400 : 503).json({ error });
        return;
      }
      await db.approvalRequest.update({
        where: { id: approval.id },
        data: {
          payload: { ...(approval.payload as Prisma.JsonObject), usedAt: at.toISOString() },
        },
      });
      await record("success");
      // With a fresh key, fetch the feed now instead of waiting for the daily run.
      if (
        name === WORDFENCE_KEY_REF &&
        deps.notifier &&
        !isSyncing() &&
        (await readFeedStatus(db)).ok !== true
      ) {
        const notifier = deps.notifier;
        void syncVulnerabilities(
          { db, now, runner: deps.runner, notifier },
          { userId: user.id, ip },
        ).catch(() => undefined);
      }
      if (name === CLOUDFLARE_TOKEN_REF)
        void syncDns(
          { db, now, runner: deps.runner, notifier: deps.notifier },
          { userId: user.id, ip },
        ).catch(() => undefined);
      res.json({ setAt: result.updatedAt });
    } finally {
      inFlight.delete(approval.id);
    }
  });

  return router;
}
