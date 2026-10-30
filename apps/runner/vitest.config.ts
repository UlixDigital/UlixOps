import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Local runs read TEST_WP_SSH from the repo-root .env (the local test site); CI has no test site.
const rootEnv = path.resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({ test: {} });
