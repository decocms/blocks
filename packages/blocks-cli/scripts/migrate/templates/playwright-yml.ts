/**
 * Scaffolds the E2E harness and its config/smoke companions:
 *   .github/workflows/playwright.yml  — GitHub Actions workflow (chromium + webkit)
 *   playwright.config.ts              — self-contained config (no support helpers)
 *   tests/e2e/smoke.spec.ts           — harness smoke, no app boot, no network
 *
 * Design rationale:
 *   - The smoke proves the Playwright harness runs in CI (chromium + webkit)
 *     without the app booting or hitting the network — it renders inline HTML
 *     via page.setContent. Real storefront specs (page.goto("/")) need a VCR
 *     layer so CI does not hit the commerce API; add a `webServer` block to the
 *     config and specs that navigate the app once that harness exists.
 *   - webkit is included because the storefront audience is majority iOS Safari.
 *   - The workflow needs `@playwright/test` + the `test:e2e` script, both in the
 *     scaffolded package.json.
 *
 * @param bunVersion  Bun version for setup-bun (= CANONICAL_BUN_VERSION).
 */
export function generatePlaywrightFiles(bunVersion: string): Record<string, string> {
  const bun = bunVersion.replace(/^bun@/, "");
  return {
    ".github/workflows/playwright.yml": generatePlaywrightYml(bun),
    "playwright.config.ts": PLAYWRIGHT_CONFIG,
    "tests/e2e/smoke.spec.ts": SMOKE_SPEC,
  };
}

function generatePlaywrightYml(bunVersion: string): string {
  return `name: Playwright

# Functional E2E (chromium + webkit). Today only a harness smoke that renders
# inline HTML — no app boot, no network — so it runs on a plain ubuntu runner.
# When specs navigate the real app (via VCR), pin the container and add a
# webServer block to playwright.config.ts.

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: playwright-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${bunVersion}"

      - name: bun install --frozen-lockfile
        run: bun install --frozen-lockfile

      - name: Install browsers (chromium + webkit)
        run: bunx playwright install --with-deps chromium webkit

      - name: E2E
        run: bun run test:e2e

      - name: Upload HTML report
        if: \${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
`;
}

const PLAYWRIGHT_CONFIG = `/**
 * Playwright config — E2E base.
 *
 * Today only a harness smoke (tests/e2e/smoke.spec.ts) that renders inline HTML,
 * proving the harness runs in CI without the app booting or hitting the network.
 * Real app E2E (page.goto("/")) needs a VCR layer so CI does not call the
 * commerce API — add a \`webServer\` block (e.g. { command: "bun run build && bun
 * run preview", url: "http://localhost:4173" }) and the navigating specs then.
 *
 * chromium + webkit (webkit because the storefront audience is majority iOS
 * Safari). 1 worker, 0 retries on purpose: retry masks flake instead of exposing it.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
`;

const SMOKE_SPEC = `/**
 * Smoke E2E — proves the Playwright harness runs (chromium + webkit) in CI
 * without the app booting or hitting the network. Does not test the real app;
 * the storefront E2E (page.goto("/")) comes with the VCR + cassettes harness.
 */

import { expect, test } from "@playwright/test";

test("harness renders inline content", async ({ page }) => {
  await page.setContent(
    '<title>e2e smoke</title><h1>ok</h1><div data-testid="marker">ready</div>',
  );

  await expect(page).toHaveTitle("e2e smoke");
  await expect(page.getByRole("heading", { name: "ok" })).toBeVisible();
  await expect(page.getByTestId("marker")).toHaveText("ready");
});
`;
