// Settings (spec screen 22): the IP allowlist is live; snapshot retention from step 8.
import { allowlistPermits, isValidCidr, parseCidr } from "@ulixops/shared/ip";
import {
  HealthCheckSettings,
  IpAllowlistSetting,
  type SettingsView,
  SnapshotRetentionSetting,
} from "@ulixops/shared";
import { Router } from "express";
import { audit } from "../audit";
import { POLICY } from "../auth/policy";
import type { Db } from "../db";
import { readHealthSettings, writeHealthSettings } from "../health/settings";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { readNotificationPrefs } from "../notifications/prefs";
import { readRetentionDays, writeRetentionDays } from "../snapshots/retention";

const ALLOWLIST_KEY = "ip_allowlist";
const EMPTY_ALLOWLIST: IpAllowlistSetting = { enabled: false, entries: [] };

export interface SettingsDeps {
  db: Db;
  now: () => Date;
  /** ALLOWED_IPS from the server environment (always allowed). */
  envAllowedIps: string[];
  /** Which integrations have credentials configured (names only, never values). */
  configured: Record<string, boolean>;
  defaultRetentionDays: number;
}

export async function readAllowlist(db: Db): Promise<IpAllowlistSetting> {
  const row = await db.setting.findUnique({ where: { key: ALLOWLIST_KEY } });
  const parsed = IpAllowlistSetting.safeParse(row?.value);
  return parsed.success ? parsed.data : EMPTY_ALLOWLIST;
}

function integrations(configured: Record<string, boolean>): SettingsView["integrations"] {
  const status = (key: string) => (configured[key] ? "configured" : "not_configured");
  return [
    {
      key: "vault",
      name: "Secrets vault (Infisical)",
      status: status("vault"),
      note: "Used only by the runner; Settings checks it live",
    },
    {
      key: "wpengine",
      name: "WP Engine API",
      status: status("wpengine"),
      note: "Full backups before major updates",
    },
    {
      key: "smtp",
      name: "Email (SMTP)",
      status: status("smtp"),
      note: "SMTP_URL on the server; event toggles below",
    },
    {
      key: "slack",
      name: "Slack",
      status: status("slack"),
      note: "SLACK_WEBHOOK_URL on the server; event toggles below",
    },
    { key: "drive", name: "Google Drive", status: "planned", note: "Scheduled backups, Phase 2" },
    {
      key: "cloudflare",
      name: "Cloudflare DNS",
      status: "planned",
      note: "DNS management, Phase 3",
    },
  ];
}

export function settingsRouter(deps: SettingsDeps): Router {
  const { db, now } = deps;
  const router = Router();
  router.use(authorize("settings.manage", deps));

  router.get("/", async (req, res) => {
    const view: SettingsView = {
      ipAllowlist: await readAllowlist(db),
      envAllowedIps: deps.envAllowedIps,
      currentIp: clientIpOf(req),
      policy: {
        idleMinutes: POLICY.idleMs / 60_000,
        absoluteHours: POLICY.absoluteMs / 3_600_000,
        lockAfterFailures: POLICY.lockAfterFailures,
        lockMinutes: POLICY.lockWindowSec / 60,
      },
      snapshotRetentionDays: await readRetentionDays(db, deps.defaultRetentionDays),
      healthCheck: await readHealthSettings(db),
      notificationPrefs: await readNotificationPrefs(db),
      integrations: integrations(deps.configured),
    };
    res.json(view);
  });

  router.put("/health-check", async (req, res) => {
    const body = HealthCheckSettings.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const before = await readHealthSettings(db);
    const { user } = sessionOf(req);
    const after = await writeHealthSettings(db, body.data, user.id);
    await audit(
      db,
      {
        userId: user.id,
        action: "settings.health_check",
        result: "success",
        ip: clientIpOf(req),
        meta: { before, after },
      },
      now(),
    );
    res.json(after);
  });

  router.put("/snapshot-retention", async (req, res) => {
    const body = SnapshotRetentionSetting.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const before = await readRetentionDays(db, deps.defaultRetentionDays);
    const { user } = sessionOf(req);
    const after = await writeRetentionDays(db, body.data.days, user.id);
    await audit(
      db,
      {
        userId: user.id,
        action: "settings.snapshot_retention",
        result: "success",
        ip: clientIpOf(req),
        meta: { before, after },
      },
      now(),
    );
    res.json({ days: after });
  });

  router.put("/ip-allowlist", async (req, res) => {
    const body = IpAllowlistSetting.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (!body.data.entries.every((entry) => isValidCidr(entry.cidr))) {
      res.status(422).json({ error: "invalid_entries" });
      return;
    }
    const next: IpAllowlistSetting = {
      enabled: body.data.enabled,
      entries: body.data.entries.map((entry) => {
        const cidr = parseCidr(entry.cidr);
        const max = cidr?.type === "ipv4" ? 32 : 128;
        const normalized =
          cidr && cidr.prefix === max ? cidr.address : `${cidr?.address}/${cidr?.prefix}`;
        return { cidr: normalized, label: entry.label };
      }),
    };
    // Refuse a list that would shut out the Admin saving it.
    const permitted = allowlistPermits(clientIpOf(req), {
      enabled: next.enabled,
      cidrs: next.entries.map((e) => e.cidr),
      envCidrs: deps.envAllowedIps,
    });
    if (!permitted) {
      res.status(409).json({ error: "would_lock_you_out" });
      return;
    }
    const before = await readAllowlist(db);
    const { user } = sessionOf(req);
    await db.setting.upsert({
      where: { key: ALLOWLIST_KEY },
      create: { key: ALLOWLIST_KEY, value: next, updatedById: user.id },
      update: { value: next, updatedById: user.id },
    });
    await audit(
      db,
      {
        userId: user.id,
        action: "settings.ip_allowlist",
        result: "success",
        ip: clientIpOf(req),
        meta: { before, after: next },
      },
      now(),
    );
    res.json(next);
  });

  return router;
}

/** For the web proxy only, on the internal network: what to enforce on every request. */
export function internalRouter(deps: { db: Db }): Router {
  const router = Router();
  router.get("/ip-allowlist", async (_req, res) => {
    const allowlist = await readAllowlist(deps.db);
    res.set("Cache-Control", "no-store");
    res.json({ enabled: allowlist.enabled, cidrs: allowlist.entries.map((e) => e.cidr) });
  });
  return router;
}
