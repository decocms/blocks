import { describe, expect, it, vi } from "vitest";

vi.mock("@decocms/blocks-admin", () => ({
  corsHeaders: vi.fn(() => ({})),
  handleInvoke: vi.fn(),
  handleMeta: vi.fn(),
  handleRender: vi.fn(),
}));

vi.mock("@decocms/blocks/middleware/observability", () => ({
  withTracing: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

import * as adminRoutes from "./adminRoutes";
import { decoInvokeRouteConfig, decoMetaRouteConfig, decoRenderRouteConfig } from "./adminRoutes";

/**
 * Regression guard for the dev-HMR brick:
 *
 * TanStack router-core's `BaseRoute.update()` mutates the options object it
 * is handed (`Object.assign(this.options, options)` — injecting `id`/`path`).
 * Before 7.10.0 this module exported shared module-scope literals
 * (`decoMetaRoute`/`decoRenderRoute`/`decoInvokeRoute`); a site passing one
 * by reference polluted it on first execution, and on any HMR re-execution
 * the route constructor threw
 * `Route cannot have both an 'id' and a 'path' option` — every route 500ed
 * until dev restart.
 *
 * The `*RouteConfig()` factories must therefore return a FRESH object on
 * every call, and the shared literals must never be (re-)exported.
 */
describe("admin route config factories", () => {
  const cases = [
    {
      name: "decoMetaRouteConfig",
      factory: decoMetaRouteConfig,
      methods: ["GET", "OPTIONS"],
    },
    {
      name: "decoRenderRouteConfig",
      factory: decoRenderRouteConfig,
      methods: ["GET", "POST", "OPTIONS"],
    },
    {
      name: "decoInvokeRouteConfig",
      factory: decoInvokeRouteConfig,
      methods: ["GET", "POST", "OPTIONS"],
    },
  ] as const;

  for (const { name, factory, methods } of cases) {
    describe(name, () => {
      it("returns a new object on every call", () => {
        expect(factory()).not.toBe(factory());
      });

      it("returns structurally equal configs across calls", () => {
        expect(factory()).toEqual(factory());
      });

      it(`exposes server handlers for ${methods.join("/")}`, () => {
        const config = factory() as {
          server: { handlers: Record<string, unknown> };
        };
        expect(Object.keys(config.server.handlers).sort()).toEqual([...methods].sort());
        for (const method of methods) {
          expect(config.server.handlers[method]).toBeTypeOf("function");
        }
      });

      it("survives router-core-style mutation without polluting later calls", () => {
        // Simulate BaseRoute.update(): Object.assign(this.options, options)
        // pollutes whatever object createFileRoute was handed.
        const options = factory() as Record<string, unknown>;
        Object.assign(options, { id: "/deco/x", path: "/deco/x" });

        // The next module execution (HMR) gets a clean object again.
        const next = factory();
        expect(next).not.toHaveProperty("id");
        expect(next).not.toHaveProperty("path");
      });
    });
  }

  it("does NOT export the removed pre-7.10.0 literals (dev-HMR footgun)", () => {
    // The shared module-scope literals were removed in 7.10.0. Re-exporting
    // them would reintroduce the HMR brick for any site passing them by
    // reference to createFileRoute.
    const removed = ["decoMetaRoute", "decoRenderRoute", "decoInvokeRoute"];
    for (const name of removed) {
      expect(adminRoutes, `"${name}" must not be exported`).not.toHaveProperty(name);
    }
    expect(Object.keys(adminRoutes).sort()).toEqual([
      "decoInvokeRouteConfig",
      "decoMetaRouteConfig",
      "decoRenderRouteConfig",
    ]);
  });
});
