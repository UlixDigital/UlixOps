import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

// Host-run dev keeps DATABASE_URL in the repo-root .env; containers get it from compose.
const rootEnv = path.resolve(import.meta.dirname, "../../.env");
if (!process.env.DATABASE_URL && !process.env.MIGRATION_DATABASE_URL && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations run as the database owner; the API itself connects as the restricted app role.
  datasource: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "" },
});
