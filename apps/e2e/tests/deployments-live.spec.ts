// Playwright smoke for the deploy live view (Build Order step 12).
// Full deploy→fail→rollback against test-wp lives in apps/runner deploy-rollback.e2e.test.ts
// (real SSH). This suite only checks the UI is reachable when E2E_BASE_URL is set.
import { expect, test } from "@playwright/test";

const enabled = Boolean(process.env.E2E_BASE_URL);

test.describe("deployments UI", () => {
  test.skip(!enabled, "Set E2E_BASE_URL to the running web app (e.g. http://localhost:3000)");

  test("login page is served (session required for /deployments)", async ({ page }) => {
    await page.goto("/deployments");
    // Unauthenticated visitors are sent to sign-in.
    await expect(page).toHaveURL(/login/);
    await expect(page.getByRole("heading", { name: /sign in|ulixops/i }).first()).toBeVisible();
  });
});
