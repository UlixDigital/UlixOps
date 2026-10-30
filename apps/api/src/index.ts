import { Redis } from "ioredis";
import { createApp } from "./app";
import { LoginGuard, RedisCounter } from "./auth/limits";
import { hashPassword } from "./auth/password";
import { AuthService } from "./auth/service";
import { newToken } from "./auth/tokens";
import { createPrisma } from "./db";
import { parseIpList } from "@ulixops/shared/ip";
import { loadEnv } from "./env";
import { createSmtpMailer, createSlackPoster, defaultMailFrom } from "./notifications/channels";
import { createHubNotifier } from "./notify";
import { PluginStore } from "./plugins/store";
import { BullRunnerClient } from "./runner/client";
import { recoverOrphanedBulkUpdates } from "./snapshots/bulk-update-run";
import { SnapshotStore } from "./snapshots/store";

const env = loadEnv();
const db = createPrisma(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

const now = () => new Date();
const smtpUrl = process.env.SMTP_URL?.trim() || "";
const slackUrl = process.env.SLACK_WEBHOOK_URL?.trim() || "";
const mailer = smtpUrl ? createSmtpMailer(smtpUrl, defaultMailFrom(env.PUBLIC_URL)) : null;
const slack = slackUrl ? createSlackPoster(slackUrl) : null;
const notifier = createHubNotifier({
  db,
  now,
  mailer,
  slack,
  publicUrl: env.PUBLIC_URL,
});

// Queue connections must not time out blocking commands (maxRetriesPerRequest: null).
const runner = new BullRunnerClient(() => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
const auth = new AuthService({
  db,
  guard: new LoginGuard(new RedisCounter(redis), env.SESSION_SECRET),
  notifier,
  now,
  sessionSecret: env.SESSION_SECRET,
  totpKey: env.TOTP_ENCRYPTION_KEY,
  issuer: "UlixOps",
  webauthn: {
    rpID: new URL(env.PUBLIC_URL).hostname,
    rpName: "UlixOps",
    origin: new URL(env.PUBLIC_URL).origin,
  },
  dummyPasswordHash: await hashPassword(newToken()),
});

await recoverOrphanedBulkUpdates(db, now);

const server = createApp({
  auth,
  db,
  now,
  runner,
  pluginStore: new PluginStore(env.PLUGIN_STORE_DIR),
  snapshotStore: new SnapshotStore(env.SNAPSHOT_STORE_DIR),
  defaultRetentionDays: env.SNAPSHOT_RETENTION_DAYS,
  notifier,
  sessionSecret: env.SESSION_SECRET,
  publicUrl: env.PUBLIC_URL,
  envAllowedIps: parseIpList(env.ALLOWED_IPS),
  // Presence only: the values are never read here or shown anywhere.
  configured: {
    // The vault login lives only in the runner; the web checks the vault through it.
    vault: false,
    wpengine: Boolean(process.env.WPENGINE_API_USER && process.env.WPENGINE_API_PASSWORD),
    smtp: Boolean(smtpUrl && mailer),
    slack: Boolean(slackUrl && slack),
  },
}).listen(env.API_PORT, () => {
  console.log(`api: listening on port ${env.API_PORT}`);
});

function shutdown(signal: NodeJS.Signals) {
  console.log(`api: ${signal} received, shutting down`);
  server.close(() => {
    void Promise.allSettled([db.$disconnect(), redis.quit(), runner.close()]).then(() =>
      process.exit(0),
    );
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
