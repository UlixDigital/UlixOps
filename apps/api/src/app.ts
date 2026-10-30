import { ROLE_PERMISSIONS } from "@ulixops/shared";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { accountRouter } from "./account/routes";
import { approvalsRouter } from "./approvals/routes";
import { alertsRouter, auditRouter } from "./audit/routes";
import { authRouter } from "./auth/routes";
import type { AuthService } from "./auth/service";
import type { Db } from "./db";
import { credentialsRouter } from "./credentials/routes";
import { deploymentsRouter, onDeployBulkDecided } from "./deployments/routes";
import { authenticate, sessionOf } from "./http/guard";
import { notificationsRouter } from "./notifications/routes";
import { logNotifier, type SecurityNotifier } from "./notify";
import type { RunnerClient } from "./runner/client";
import { internalRouter, settingsRouter } from "./settings/routes";
import { pluginsRouter } from "./plugins/routes";
import type { PluginStore } from "./plugins/store";
import { healthSiteRouter } from "./health/routes";
import { onBulkUpdateApproved } from "./snapshots/bulk-update-run";
import { backupsRouter, snapshotSiteRouter } from "./snapshots/routes";
import type { SnapshotStore } from "./snapshots/store";
import { siteOpsRouter } from "./sites/operations";
import { sitesRouter } from "./sites/routes";
import { usersRouter } from "./users/routes";

export interface AppDeps {
  auth?: AuthService;
  db?: Db;
  now?: () => Date;
  notifier?: SecurityNotifier;
  /** Keys setup-link tokens; the same SESSION_SECRET the AuthService uses. */
  sessionSecret?: string;
  publicUrl?: string;
  envAllowedIps?: string[];
  configured?: Record<string, boolean>;
  /** The only way to reach sites or the vault (step 5). */
  runner?: RunnerClient;
  /** Where plugin ZIPs are kept (step 7). */
  pluginStore?: PluginStore;
  /** Encrypted quick snapshots on disk (step 8); API deletes expired files only. */
  snapshotStore?: SnapshotStore;
  defaultRetentionDays?: number;
}

const SIGNED_IN_PATHS = [
  "/me",
  "/account",
  "/users",
  "/settings",
  "/audit",
  "/alerts",
  "/sites",
  "/credentials",
  "/approvals",
  "/plugins",
  "/backups",
  "/deployments",
  "/notifications",
];

export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.disable("x-powered-by");

  // JSON-only API: nothing it serves should ever load scripts, frames or other resources.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
      frameguard: { action: "deny" },
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.auth) app.use("/auth", authRouter(deps.auth));

  // Everything below acts for a signed-in user and checks their role.
  if (deps.auth && deps.db) {
    const db = deps.db;
    const now = deps.now ?? (() => new Date());
    const guarded = { db, now };
    app.use("/internal", internalRouter({ db }));
    app.use(
      SIGNED_IN_PATHS,
      (_req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
      },
      authenticate(deps.auth),
    );
    app.get("/me", (req, res) => {
      const { user } = sessionOf(req);
      res.json({ user, permissions: ROLE_PERMISSIONS[user.role] });
    });
    app.use("/account", accountRouter({ ...guarded, auth: deps.auth }));
    app.use(
      "/users",
      usersRouter({
        ...guarded,
        notifier: deps.notifier ?? logNotifier,
        sessionSecret: deps.sessionSecret ?? "",
        publicUrl: deps.publicUrl ?? "http://localhost:3000",
      }),
    );
    const notifier = deps.notifier ?? logNotifier;
    const configured = deps.configured ?? {};
    app.use(
      "/settings",
      settingsRouter({
        ...guarded,
        envAllowedIps: deps.envAllowedIps ?? [],
        configured,
        defaultRetentionDays: deps.defaultRetentionDays ?? 7,
      }),
    );
    app.use("/audit", auditRouter(guarded));
    app.use("/alerts", alertsRouter(guarded));
    app.use(
      "/notifications",
      notificationsRouter({
        ...guarded,
        configured: {
          email: Boolean(configured.smtp),
          slack: Boolean(configured.slack),
        },
      }),
    );
    if (deps.pluginStore)
      app.use("/plugins", pluginsRouter({ ...guarded, store: deps.pluginStore }));
    if (deps.runner) {
      const siteDeps = { ...guarded, runner: deps.runner, notifier };
      app.use("/sites", sitesRouter(siteDeps), siteOpsRouter(siteDeps), healthSiteRouter(siteDeps));
      app.use("/credentials", credentialsRouter({ ...guarded, runner: deps.runner }));
      if (deps.snapshotStore) {
        const snapDeps = {
          ...siteDeps,
          snapshots: deps.snapshotStore,
          defaultRetentionDays: deps.defaultRetentionDays ?? 7,
        };
        app.use("/sites", snapshotSiteRouter(snapDeps));
        app.use("/backups", backupsRouter(snapDeps));
        const deployDeps = {
          ...guarded,
          runner: deps.runner,
          snapshots: deps.snapshotStore,
          defaultRetentionDays: deps.defaultRetentionDays ?? 7,
          notifier,
        };
        app.use("/deployments", deploymentsRouter(deployDeps));
        app.use(
          "/approvals",
          approvalsRouter({
            ...guarded,
            notifier,
            onDeployBulkDecided: (decision, deploymentId, decidedById) =>
              onDeployBulkDecided(deployDeps, decision, deploymentId, decidedById),
            onBulkUpdateApproved: (payload, decidedById, requestId, requesterId) => {
              const parsed = payload as {
                siteId?: string;
                kind?: string;
                items?: {
                  asset: "plugin" | "theme";
                  name: string;
                  version: string;
                  updateVersion: string;
                  safety?: "patch" | "minor" | "major" | "unknown";
                }[];
              };
              if (!parsed?.siteId || !parsed.kind || !parsed.items) return;
              // Fire-and-forget: approvals route already does not await (A108).
              void onBulkUpdateApproved(
                snapDeps,
                { siteId: parsed.siteId, kind: parsed.kind, items: parsed.items },
                decidedById,
                requestId,
                requesterId,
              ).catch((error) => {
                console.error(
                  JSON.stringify({
                    event: "bulk_update_run_failed",
                    requestId,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
              });
            },
          }),
        );
      } else {
        app.use("/approvals", approvalsRouter({ ...guarded, notifier }));
      }
    } else {
      app.use("/approvals", approvalsRouter({ ...guarded, notifier }));
    }
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const handleError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status = clientErrorStatus(err) ?? 500;
    if (status === 500) {
      console.error(`api: unhandled error: ${err instanceof Error ? err.name : typeof err}`);
    }
    res.status(status).json({ error: status === 500 ? "internal_error" : "bad_request" });
  };
  app.use(handleError);

  return app;
}

/** 4xx status attached by Express middleware (e.g. malformed JSON), if any. */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  const { status } = err;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}
