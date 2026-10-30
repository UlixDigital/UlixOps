import { parseEnv } from "@ulixops/shared";
import { z } from "zod";

// No DATABASE_URL on purpose: the runner never talks to Postgres (agent decision A3).
const Env = z.object({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // The vault: only the runner holds these (agent decision A46).
  INFISICAL_URL: z.url({ protocol: /^https?$/ }).default("http://infisical:8080"),
  INFISICAL_CLIENT_ID: z.string().min(1),
  INFISICAL_CLIENT_SECRET: z.string().min(1),
  INFISICAL_PROJECT_ID: z.string().min(1),
  INFISICAL_ENVIRONMENT: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .default("prod"),
  INFISICAL_SECRET_PATH: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/)
    .default("/ssh-keys"),
  /** Encrypted quick snapshots (Build Order step 8). Shared volume with the API for deletes. */
  SNAPSHOT_STORE_DIR: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]{0,250}$/, "an absolute path")
    .refine((p) => !p.includes(".."), "an absolute path without ..")
    .default("/data/snapshots"),
  /** AES-256 key for snapshot blobs; only the runner holds it (agent decision A69). */
  SNAPSHOT_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters (32 bytes)"),
  /** Registry plugin ZIPs, read-only (A63 / A81). Shared volume with the API. */
  PLUGIN_STORE_DIR: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]{0,250}$/, "an absolute path")
    .refine((p) => !p.includes(".."), "an absolute path without ..")
    .default("/data/plugins"),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return parseEnv(Env, source);
}
