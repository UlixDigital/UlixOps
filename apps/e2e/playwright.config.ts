import { defineConfig } from "@playwright/test";

/** Set E2E_BASE_URL (e.g. http://localhost:3000) when the local stack is up. */
const baseURL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: baseURL || "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  // No webServer: the Compose stack must already be running (A94).
});
