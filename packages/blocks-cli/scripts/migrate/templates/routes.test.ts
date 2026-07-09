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
 * dev-HMR-safe `*RouteConfig()` factories, never the shared module-scope
 * literals passed by reference. router-core's `update()` mutates the options
 * object it receives (injects id/path); a shared literal gets polluted on
 * first execution, and any dev-HMR re-execution of the route file then throws
 * "Route cannot have both an 'id' and a 'path' option", 500ing every route
 * until the dev server restarts.
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
