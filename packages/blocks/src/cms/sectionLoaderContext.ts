/**
 * Section-loader compatibility context (`ctx`) — issue #305.
 *
 * deco.cx (Fresh) section loaders use a 3-arg signature
 * `(props, req, ctx: AppContext)`, where `ctx` exposes device detection,
 * `ctx.invoke.*`, per-app state (`ctx.vtex`, `ctx.salesforce`, …) and
 * `ctx.response.headers`. `@decocms/blocks` invokes loaders with only
 * `(props, req)`, so migrated loaders read `undefined` and throw.
 *
 * Rather than delete `ctx` (which would force rewriting every migrated
 * loader by hand), we re-assemble a **real** compat `ctx` from the primitives
 * the framework already has — no fabricated stubs (policy D3):
 *
 * - `device`  → {@link detectDevice} on the request User-Agent. Derived from
 *   `req` (NOT `RequestContext`) on purpose: the `createServerFn` path used in
 *   dev / SPA navigation is not wrapped in `RequestContext.run`, so a
 *   RequestContext-only device would silently degrade to "desktop" there.
 * - `invoke`  → the same nested invoke proxy the client uses, but pointed at
 *   an absolute self-origin and routed through `RequestContext.fetch` so the
 *   request's AbortSignal propagates. `ctx.invoke.vtex.loaders.x(props)` works
 *   server-side via a self-fetch to `/deco/invoke`.
 * - app state → `RequestContext.getAppState(name)`; any unknown property access
 *   (`ctx.vtex`, `ctx.salesforce`, …) resolves to the app's registered state
 *   or `undefined`. Real lookup, not a fake object.
 * - `response.headers` → `RequestContext.responseHeaders` when in a request
 *   scope; an inert `Headers` otherwise (writes don't propagate in dev/SPA but
 *   never crash).
 */

import { type Device, detectDevice } from "../sdk/detectDevice";
import { createAppInvokeWith } from "../sdk/invoke";
import { RequestContext } from "../sdk/requestContext";

/**
 * The compat context handed to section loaders as the 3rd argument.
 *
 * It is indexable (`[appName: string]: unknown`) because Fresh loaders read
 * per-app state off `ctx` directly (`ctx.vtex`, `ctx.salesforce`, …). Those
 * reads resolve through {@link RequestContext.getAppState}. Migrated code
 * should still optional-chain deep app-state reads (`ctx.vtex?.config`), since
 * an app that isn't configured yields `undefined`.
 */
export interface SectionLoaderContext {
  /** Device type detected from the request User-Agent. */
  device: Device;
  /**
   * Nested invoke proxy (`ctx.invoke.vtex.loaders.x(props)`), bound to this
   * request's origin and AbortSignal. Works server-side via self-fetch.
   */
  invoke: any;
  /** Outgoing response headers (e.g. for Set-Cookie forwarding). */
  response: { headers: Headers };
  /** Typed access to an app's request-scoped state. */
  getAppState: <T>(appName: string) => T | undefined;
  /** Per-app state read directly off ctx (Fresh compatibility). */
  [appName: string]: unknown;
}

/**
 * Build the compat {@link SectionLoaderContext} for a single loader call.
 * Cheap to construct (device detect + lazy proxies), so it's fine to build
 * per section loader invocation.
 */
export function buildSectionLoaderContext(req: Request): SectionLoaderContext {
  // Defensive: `req` may be a minimal/mock request without a real `headers`
  // object. Building the ctx must never throw — that would take down the
  // loader before it runs.
  const device = detectDevice(req.headers?.get?.("user-agent") ?? "");

  let origin = "";
  try {
    origin = new URL(req.url).origin;
  } catch {
    // Relative/opaque request URL — fall back to a relative base path.
  }

  const invoke = createAppInvokeWith({
    basePath: `${origin}/deco/invoke`,
    fetcher: (input, init) => RequestContext.fetch(input, init),
  });

  const base = {
    device,
    invoke,
    get response(): { headers: Headers } {
      // `responseHeaders` throws outside a request scope (dev/SPA serverFn
      // path). Degrade to an inert Headers rather than crash the loader.
      let headers: Headers;
      try {
        headers = RequestContext.responseHeaders;
      } catch {
        headers = new Headers();
      }
      return { headers };
    },
    getAppState<T>(appName: string): T | undefined {
      return RequestContext.getAppState<T>(appName);
    },
  };

  const known = new Set(["device", "invoke", "response", "getAppState"]);

  // Wrap so unknown property access (`ctx.vtex`, `ctx.salesforce`, …) resolves
  // to the app's registered state. Known fields fall through to `base`.
  return new Proxy(base as SectionLoaderContext, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !known.has(prop) && !(prop in target)) {
        return RequestContext.getAppState(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
