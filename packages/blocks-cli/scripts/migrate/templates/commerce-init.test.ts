import { describe, expect, it } from "vitest";
import type { MigrationContext } from "../types";
import { createContext } from "../types";
import { generateCommerceInit } from "./commerce-init";
import { generateServerEntry } from "./server-entry";
import { generateSetup } from "./setup";

function makeCtx(platform: MigrationContext["platform"]): MigrationContext {
  const ctx = createContext("/tmp/commerce-init-template-fixture-site");
  ctx.siteName = "acme-storefront";
  ctx.platform = platform;
  ctx.vtexAccount = platform === "vtex" ? "acme" : null;
  return ctx;
}

/**
 * Regression guard for the site loader/action bundle-leak boundary.
 *
 * COMMERCE_LOADERS (and every site loader/action module it imports) must be
 * registered in a server-only module imported by the worker entry, NEVER by
 * setup.ts — which router.tsx imports into the client bundle. If the
 * registration leaks back into setup.ts, the whole loader/action graph (and any
 * credential hardcoded in it) ships to the browser assets again.
 */
describe("server-only commerce/invoke registration boundary", () => {
  for (const platform of ["vtex", "custom"] as const) {
    describe(`platform: ${platform}`, () => {
      const ctx = makeCtx(platform);
      const commerceInit = generateCommerceInit(ctx);
      const setup = generateSetup(ctx);
      const serverFiles = generateServerEntry(ctx);

      it("commerce-init registers COMMERCE_LOADERS + invoke server-side", () => {
        expect(commerceInit).toContain(`import { COMMERCE_LOADERS } from "./commerce-loaders"`);
        expect(commerceInit).toContain("registerCommerceLoaders(COMMERCE_LOADERS)");
        expect(commerceInit).toContain("setInvokeLoaders(() => COMMERCE_LOADERS)");
      });

      it("setup.ts (client-imported) does NOT import or register COMMERCE_LOADERS", () => {
        // The doc comment may reference COMMERCE_LOADERS; what must be absent is
        // the actual import + the server-only registration calls.
        expect(setup).not.toContain('from "./setup/commerce-loaders"');
        expect(setup).not.toContain("registerCommerceLoaders(");
        expect(setup).not.toContain("setInvokeLoaders(");
      });

      it("worker-entry imports commerce-init, router.tsx does not", () => {
        expect(serverFiles["src/worker-entry.ts"]).toContain('import "./setup/commerce-init"');
        expect(serverFiles["src/router.tsx"]).not.toContain("commerce-init");
        // router.tsx still imports the client-safe setup for section registration.
        expect(serverFiles["src/router.tsx"]).toContain('import "./setup"');
      });
    });
  }
});
