import { defineConfig } from "vitest/config";

// Each package supplies its own environment via environmentMatchGlobs —
// packages/blocks-cli's scripts/** run in node (filesystem, migration logic),
// every other package's src/** runs in jsdom (React rendering, hooks).
export default defineConfig({
  test: {
    environment: "jsdom",
    environmentMatchGlobs: [
      ["packages/blocks-cli/scripts/**", "node"],
    ],
    include: [
      "packages/*/src/**/*.test.{ts,tsx,js}",
      "packages/blocks-cli/scripts/**/*.test.ts",
    ],
    globals: true,
  },
});
