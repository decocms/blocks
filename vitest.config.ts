import { defineConfig } from "vitest/config";

// One config for the whole repo: `bun run test` at the root runs every
// package, the cross-package tests in tests/ and the migration skill's
// scripts. Files that need Node APIs say so with `// @vitest-environment node`.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "tests/**/*.test.ts",
      ".agents/skills/*/scripts/**/*.test.ts",
    ],
    globals: true,
  },
});
