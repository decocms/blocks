import { describe, expect, it } from "vitest";
import type { MigrationContext } from "../types";
import { createContext } from "../types";
import { generateRoutes } from "./routes";

function makeCtx(platform: MigrationContext["platform"]): MigrationContext {
  const ctx = createContext("/tmp/routes-template-fixture-site");
  ctx.siteName = "acme-storefront";
  ctx.platform = platform;
  ctx.vtexAccount = platform === "vtex" ? "acme" : null;
  return ctx;
}

/**
 * Regression guard: the scaffolded deco admin route files must use the
 * dev-HMR-safe `*RouteConfig()` factories — the only form @decocms/tanstack
 * exports since 7.10.0 — never the removed pre-7.10.0 module-scope literals
 * passed by reference. router-core's `update()` mutates the options object it
 * receives (injects id/path); a shared literal got polluted on first
 * execution, and any dev-HMR re-execution of the route file then threw
 * "Route cannot have both an 'id' and a 'path' option", 500ing every route
 * until the dev server restarted.
 */
describe("scaffolded deco admin routes use HMR-safe factories", () => {
  const routeCases = [
    { file: "src/routes/deco/meta.ts", factory: "decoMetaRouteConfig", literal: "decoMetaRoute" },
    {
      file: "src/routes/deco/render.ts",
      factory: "decoRenderRouteConfig",
      literal: "decoRenderRoute",
    },
    {
      file: "src/routes/deco/invoke.$.ts",
      factory: "decoInvokeRouteConfig",
      literal: "decoInvokeRoute",
    },
  ] as const;

  for (const platform of ["vtex", "custom"] as const) {
    describe(`platform: ${platform}`, () => {
      const files = generateRoutes(makeCtx(platform));

      for (const { file, factory, literal } of routeCases) {
        it(`${file} calls ${factory}() and never passes ${literal} by reference`, () => {
          const content = files[file];
          expect(content, `${file} must be emitted`).toBeTypeOf("string");

          // Factory form: createFileRoute("...")(decoXRouteConfig())
          expect(content).toContain(`${factory}()`);
          expect(content).toContain(`import { ${factory} } from "@decocms/tanstack"`);

          // Forbidden form: createFileRoute("...")(decoXRoute) — shared
          // literal by reference. `(?!Config)` keeps the factory call legal.
          expect(content).not.toMatch(new RegExp(`\\)\\(${literal}(?!Config)\\s*\\)`));
        });
      }
    });
  }
});

/**
 * Regression guard: the page renderers must wire `loadDeferredSectionFn` to the
 * `deferredSectionLoader` shim, never the raw `loadDeferredSection` server fn.
 * `loadDeferredSection` is a createServerFn with an inputValidator, so it must
 * be called as `fn({ data })`; DeferredSectionWrapper calls `loadFn(bareArgs)`,
 * so passing the raw fn leaves `ctx.data` undefined and the deferred section
 * renders blank. The shim wraps the `{ data }` envelope.
 */
describe("scaffolded page routes wire the deferred-loader shim, not the raw server fn", () => {
  for (const platform of ["vtex", "custom"] as const) {
    describe(`platform: ${platform}`, () => {
      const files = generateRoutes(makeCtx(platform));

      for (const file of ["src/routes/index.tsx", "src/routes/$.tsx"] as const) {
        it(`${file} passes deferredSectionLoader from the sdk subpath`, () => {
          const content = files[file];
          expect(content, `${file} must be emitted`).toBeTypeOf("string");

          expect(content).toContain(
            'import { deferredSectionLoader } from "@decocms/tanstack/sdk/deferredSectionLoader"',
          );
          expect(content).toContain("loadDeferredSectionFn={deferredSectionLoader}");

          // The broken form: the raw server fn passed directly.
          expect(content).not.toContain("loadDeferredSectionFn={loadDeferredSection}");
        });
      }
    });
  }
});
