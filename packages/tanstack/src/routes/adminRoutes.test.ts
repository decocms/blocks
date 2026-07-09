import { describe, expect, it, vi } from "vitest";

vi.mock("@decocms/blocks-admin", () => ({
  corsHeaders: vi.fn(() => ({})),
  handleInvoke: vi.fn(),
  handleMeta: vi.fn(),
  handleRender: vi.fn(),
}));

vi.mock("@decocms/blocks/sdk/observability", () => ({
  withTracing: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

import {
  decoInvokeRoute,
  decoInvokeRouteConfig,
  decoMetaRoute,
  decoMetaRouteConfig,
  decoRenderRoute,
  decoRenderRouteConfig,
} from "./adminRoutes";

/**
 * Regression guard for the dev-HMR brick:
 *
 * TanStack router-core's `BaseRoute.update()` mutates the options object it
 * is handed (`Object.assign(this.options, options)` — injecting `id`/`path`).
 * If a site passes a module-scope literal by reference, the first execution
 * pollutes the shared literal; on HMR re-execution the route constructor
 * throws `Route cannot have both an 'id' and a 'path' option` and every
 * route 500s until dev restart.
 *
 * The `*RouteConfig()` factories must therefore return a FRESH object on
 * every call — never the shared literal, never a cached previous result.
 */
describe("admin route config factories", () => {
  const cases = [
    { name: "decoMetaRouteConfig", factory: decoMetaRouteConfig, literal: decoMetaRoute },
    { name: "decoRenderRouteConfig", factory: decoRenderRouteConfig, literal: decoRenderRoute },
    { name: "decoInvokeRouteConfig", factory: decoInvokeRouteConfig, literal: decoInvokeRoute },
  ] as const;

  for (const { name, factory, literal } of cases) {
    describe(name, () => {
      it("returns a fresh object, not the shared literal", () => {
        expect(factory()).not.toBe(literal);
      });

      it("returns a new object on every call", () => {
        expect(factory()).not.toBe(factory());
      });

      it("carries the literal's handler config", () => {
        expect(factory()).toEqual(literal);
      });

      it("survives router-core-style mutation without polluting the literal", () => {
        // Simulate BaseRoute.update(): Object.assign(this.options, options)
        // pollutes whatever object createFileRoute was handed.
        const options = factory() as Record<string, unknown>;
        Object.assign(options, { id: "/deco/x", path: "/deco/x" });

        expect(literal).not.toHaveProperty("id");
        expect(literal).not.toHaveProperty("path");
        // The next module execution (HMR) gets a clean object again.
        expect(factory()).not.toHaveProperty("id");
      });
    });
  }

  it("keeps the literal exports for backward compat", () => {
    for (const literal of [decoMetaRoute, decoRenderRoute, decoInvokeRoute]) {
      expect(literal).toBeTypeOf("object");
      expect(literal.server.handlers).toBeTypeOf("object");
      expect(literal.server.handlers.OPTIONS).toBeTypeOf("function");
    }
  });
});
