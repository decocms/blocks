import { describe, expect, it } from "vitest";
import { createContext } from "../types";
import type { MigrationContext } from "../types";
import { generateRoutes } from "./routes";
import { generateServerEntry } from "./server-entry";
import { generateSetup } from "./setup";
import { generateViteConfig } from "./vite-config";
import { generateCommerceInit } from "./commerce-init";
import { generateCommerceLoaders } from "./commerce-loaders";
import { generateSectionLoaders } from "./section-loaders";
import { generateHooks } from "./hooks";
import { generateUiComponents } from "./ui-components";
import { generateTypeFiles } from "./types-gen";
import { generateCacheConfig } from "./cache-config";
import { generateSdkFiles } from "./sdk-gen";
import { generatePackageJson } from "./package-json";
import { generateMigrationPolicyPointerRule } from "./cursor-rules";

/**
 * Fleet-wide regression guard: none of the scaffolder's templates may emit
 * the pre-7.x-split `@decocms/start` package, or a bare `@decocms/apps/`
 * monolith subpath import — neither exists for 7.x consumers, so any
 * occurrence here means a freshly scaffolded site ships broken code.
 *
 * `@decocms/apps-<platform>` (the current split packages) are fine and
 * intentionally NOT flagged by this check.
 */
function assertNoLegacyPackageNames(label: string, output: string) {
  expect(output, `${label} must not emit "@decocms/start"`).not.toContain(
    "@decocms/start",
  );
  expect(
    output,
    `${label} must not emit the "@decocms/apps/" monolith subpath`,
  ).not.toMatch(/@decocms\/apps\//);
}

function makeCtx(platform: MigrationContext["platform"]): MigrationContext {
  const ctx = createContext("/tmp/no-legacy-packages-fixture-site");
  ctx.siteName = "acme-storefront";
  ctx.platform = platform;
  ctx.vtexAccount = platform === "vtex" ? "acme" : null;
  return ctx;
}

describe("scaffolder templates never emit @decocms/start or @decocms/apps/*", () => {
  for (const platform of ["vtex", "custom"] as const) {
    describe(`platform: ${platform}`, () => {
      const ctx = makeCtx(platform);

      it("routes.ts", () => {
        const files = generateRoutes(ctx);
        for (const [path, content] of Object.entries(files)) {
          assertNoLegacyPackageNames(`routes.ts (${path})`, content);
        }
      });

      it("server-entry.ts", () => {
        const files = generateServerEntry(ctx);
        for (const [path, content] of Object.entries(files)) {
          assertNoLegacyPackageNames(`server-entry.ts (${path})`, content);
        }
      });

      it("setup.ts", () => {
        assertNoLegacyPackageNames("setup.ts", generateSetup(ctx));
      });

      it("vite-config.ts", () => {
        assertNoLegacyPackageNames("vite-config.ts", generateViteConfig(ctx));
      });

      it("commerce-loaders.ts", () => {
        assertNoLegacyPackageNames(
          "commerce-loaders.ts",
          generateCommerceLoaders(ctx),
        );
      });

      it("commerce-init.ts", () => {
        assertNoLegacyPackageNames("commerce-init.ts", generateCommerceInit(ctx));
      });

      it("section-loaders.ts", () => {
        assertNoLegacyPackageNames(
          "section-loaders.ts",
          generateSectionLoaders(ctx),
        );
      });

      it("hooks.ts", () => {
        const files = generateHooks(ctx);
        for (const [path, content] of Object.entries(files)) {
          assertNoLegacyPackageNames(`hooks.ts (${path})`, content);
        }
      });

      it("types-gen.ts", () => {
        const files = generateTypeFiles(ctx);
        for (const [path, content] of Object.entries(files)) {
          assertNoLegacyPackageNames(`types-gen.ts (${path})`, content);
        }
      });

      it("cache-config.ts", () => {
        assertNoLegacyPackageNames(
          "cache-config.ts",
          generateCacheConfig(ctx),
        );
      });

      it("sdk-gen.ts", () => {
        const files = generateSdkFiles(ctx);
        for (const [path, content] of Object.entries(files)) {
          assertNoLegacyPackageNames(`sdk-gen.ts (${path})`, content);
        }
      });
    });
  }

  // Platform-agnostic templates
  it("ui-components.ts", () => {
    const ctx = makeCtx("custom");
    const files = generateUiComponents(ctx);
    for (const [path, content] of Object.entries(files)) {
      assertNoLegacyPackageNames(`ui-components.ts (${path})`, content);
    }
  });

  it("cursor-rules.ts", () => {
    assertNoLegacyPackageNames(
      "cursor-rules.ts",
      generateMigrationPolicyPointerRule("acme-storefront"),
    );
  });

  // package-json.ts shells out to `npm view` to resolve the latest published
  // version, with a hardcoded fallback if that fails (offline/CI-sandboxed).
  // Either way the emitted dependency *names* must never be the retired
  // @decocms/start / @decocms/apps monolith.
  it("package-json.ts", () => {
    const ctx = makeCtx("vtex");
    const pkg = generatePackageJson(ctx);
    assertNoLegacyPackageNames("package-json.ts", pkg);
    const parsed = JSON.parse(pkg);
    expect(parsed.dependencies).not.toHaveProperty("@decocms/start");
    expect(parsed.dependencies).not.toHaveProperty("@decocms/apps");
    expect(parsed.dependencies).toHaveProperty("@decocms/blocks");
    expect(parsed.dependencies).toHaveProperty("@decocms/tanstack");
    expect(parsed.dependencies).toHaveProperty("@decocms/apps-vtex");
  }, 20000);
});
