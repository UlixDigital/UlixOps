import { REMOTE_QUEUE } from "@ulixops/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "./env";
import { handleJob } from "./jobs";
import { PluginStoreReader } from "./plugin-store";
import { redact } from "./redact";
import { SnapshotStore } from "./snapshot-store";
import { ssh2Connector } from "./ssh";
import { InfisicalVault } from "./vault";

const env = loadEnv();

// BullMQ workers need maxRetriesPerRequest: null so blocking commands are not cut off.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const vault = new InfisicalVault({
  url: env.INFISICAL_URL,
  clientId: env.INFISICAL_CLIENT_ID,
  clientSecret: env.INFISICAL_CLIENT_SECRET,
  projectId: env.INFISICAL_PROJECT_ID,
  environment: env.INFISICAL_ENVIRONMENT,
  secretPath: env.INFISICAL_SECRET_PATH,
});
const snapshots = {
  store: new SnapshotStore(env.SNAPSHOT_STORE_DIR),
  encryptionKey: env.SNAPSHOT_ENCRYPTION_KEY,
};
const plugins = new PluginStoreReader(env.PLUGIN_STORE_DIR);

const worker = new Worker(
  REMOTE_QUEUE,
  async (job) => {
    // A job nobody waited for (runner was down) must not run late.
    if (Date.now() - job.timestamp > 60_000)
      throw new Error("Job expired before the runner could start it");
    try {
      return await handleJob(job.data, { vault, ssh: ssh2Connector, snapshots, plugins });
    } catch (error) {
      // The failure reason is stored in Redis and shown to the API: redact it first. The
      // original error is deliberately not attached as `cause`, so its text can't leak.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(redact(error instanceof Error ? error.message : "Job failed", [], 500));
    }
  },
  { connection, concurrency: env.RUNNER_CONCURRENCY },
);

worker.on("ready", () => console.log(`runner: consuming "${REMOTE_QUEUE}"`));
worker.on("failed", (job, err) => {
  console.error(
    `runner: job ${job?.id ?? "unknown"} (${job?.data?.type ?? "?"}) failed: ${err.message}`,
  );
});

async function shutdown(signal: NodeJS.Signals) {
  console.log(`runner: ${signal} received, finishing active jobs`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));
