import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// One config for the whole repo: `bun run test` at the root runs every
// package, the cross-package tests in tests/ and the migration skill's
// scripts. Files that need Node APIs say so with `// @vitest-environment node`.
//
// Imports of `@decocms/*` resolve through the packages' "source" export
// condition, so a test that imports a file by relative path and one that
// imports the package name load the same module (one instance, as in an app)
// and no test needs a build. Only the spawned `deco` bin and the temp apps the
// CLI conformance tests create run dist/, which tests/globalSetup.ts builds.
export default defineConfig({
  resolve: { conditions: ["source", ...defaultClientConditions] },
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  test: {
    environment: "jsdom",
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "tests/**/*.test.ts",
      ".agents/skills/*/scripts/**/*.test.ts",
    ],
    globals: true,
    globalSetup: ["tests/globalSetup.ts"],
  },
});
