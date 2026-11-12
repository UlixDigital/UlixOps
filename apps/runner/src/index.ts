import {
  MONITOR_JOB_TYPES,
  MONITOR_QUEUE,
  REMOTE_QUEUE,
  VISUAL_JOB_TYPES,
  VISUAL_QUEUE,
} from "@ulixops/shared";
import { type Job, Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "./env";
import { clearScanWork } from "./malware-scan";
import { handleJob } from "./jobs";
import { PluginStoreReader } from "./plugin-store";
import { redact } from "./redact";
import { SealKeys } from "./sealed";
import { SnapshotStore } from "./snapshot-store";
import { FilesSessionPool } from "./files-pool";
import { ssh2Connector } from "./ssh";
import { InfisicalVault } from "./vault";
import { clearVisualWork } from "./visual";

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
// Private half stays in this process's memory; a restart makes a new pair (A133).
const seal = new SealKeys();
const filesPool = new FilesSessionPool(ssh2Connector, vault);

// Site copies left by a previous runner process (deploy mid-scan) can never finish: clear them (A142).
await clearScanWork(env.SCAN_WORK_DIR);
await clearVisualWork(env.VISUAL_WORK_DIR);

const deps = {
  vault,
  ssh: ssh2Connector,
  filesPool,
  snapshots,
  plugins,
  seal,
  scanWorkDir: env.SCAN_WORK_DIR,
  visualWorkDir: env.VISUAL_WORK_DIR,
  visualStoreDir: env.VISUAL_STORE_DIR,
};

async function runJob(job: Job, only?: readonly string[]): Promise<unknown> {
  // A job nobody waited for (runner was down) must not run late.
  if (Date.now() - job.timestamp > 60_000)
    throw new Error("Job expired before the runner could start it");
  try {
    const type: unknown = (job.data as { type?: unknown } | null)?.type;
    if (only && !only.includes(String(type))) throw new Error("Job not allowed on this queue");
    return await handleJob(job.data, {
      ...deps,
      progress: (data) => job.updateProgress(data as object),
    });
  } catch (error) {
    // The failure reason is stored in Redis and shown to the API: redact it first. The
    // original error is deliberately not attached as `cause`, so its text can't leak.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redact(error instanceof Error ? error.message : "Job failed", [], 500));
  }
}

const worker = new Worker(REMOTE_QUEUE, (job) => runJob(job), {
  connection,
  concurrency: env.RUNNER_CONCURRENCY,
});
// Uptime probes have their own queue so long SSH jobs never delay them past 60 s (A149).
const monitorConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const monitorWorker = new Worker(MONITOR_QUEUE, (job) => runJob(job, MONITOR_JOB_TYPES), {
  connection: monitorConnection,
  concurrency: 1,
});
// Screenshots take minutes; keep them off monitor-ops so uptime stays on time (A163).
const visualConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const visualWorker = new Worker(VISUAL_QUEUE, (job) => runJob(job, VISUAL_JOB_TYPES), {
  connection: visualConnection,
  concurrency: 1,
  // Captures can run for several minutes; don't stall the lock refresh.
  lockDuration: 10 * 60_000,
});

for (const [w, name] of [
  [worker, REMOTE_QUEUE],
  [monitorWorker, MONITOR_QUEUE],
  [visualWorker, VISUAL_QUEUE],
] as const) {
  w.on("ready", () => console.log(`runner: consuming "${name}"`));
  w.on("failed", (job, err) => {
    console.error(
      `runner: job ${job?.id ?? "unknown"} (${job?.data?.type ?? "?"}) failed: ${err.message}`,
    );
  });
}

async function shutdown(signal: NodeJS.Signals) {
  console.log(`runner: ${signal} received, finishing active jobs`);
  await Promise.all([worker.close(), monitorWorker.close(), visualWorker.close()]);
  filesPool.closeAll();
  await Promise.all([connection.quit(), monitorConnection.quit(), visualConnection.quit()]);
  process.exit(0);
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));
