import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Local runs read TEST_DATABASE_URL / TEST_REDIS_URL from the repo-root .env; CI sets them directly.
const rootEnv = path.resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // The integration suite shares one database.
    fileParallelism: false,
  },
});
