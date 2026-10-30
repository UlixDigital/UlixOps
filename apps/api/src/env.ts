import { parseEnv } from "@ulixops/shared";
import { z } from "zod";

const Database = {
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  SESSION_SECRET: z.string().min(32),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
};

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  ALLOWED_IPS: z.string().max(4000).default(""),
  TOTP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters (32 bytes)"),
  /** Where plugin ZIPs are kept: a volume outside any web root (agent decision A63). */
  PLUGIN_STORE_DIR: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]{0,250}$/, "an absolute path")
    .refine((p) => !p.includes(".."), "an absolute path without ..")
    .default("/data/plugins"),
  /** Encrypted quick snapshots; shared with the runner for deletes (agent decision A68). */
  SNAPSHOT_STORE_DIR: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]{0,250}$/, "an absolute path")
    .refine((p) => !p.includes(".."), "an absolute path without ..")
    .default("/data/snapshots"),
  /** Default retention when Settings has no override (spec §6.5). */
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  ...Database,
});
export type Env = z.infer<typeof Env>;

/** The admin CLI only needs the database and the token key. */
const CliEnv = z.object(Database);
export type CliEnv = z.infer<typeof CliEnv>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return parseEnv(Env, source);
}

export function loadCliEnv(source: Record<string, string | undefined> = process.env): CliEnv {
  return parseEnv(CliEnv, source);
}
