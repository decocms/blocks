/**
 * Admin Route Helpers
 *
 * Pre-built server handler config factory for the Deco invoke route
 * (`/deco/invoke/$`), which Studio edits rely on. Sites call it in their
 * `createFileRoute` definition to avoid repeating the CORS + handler
 * boilerplate.
 *
 * The staff-only admin routes (`/deco/meta`, `/deco/render`, and the
 * worker-level `/live/_meta`, `/.decofile`, `/live/previews`) were removed
 * from this package: `decoMetaRouteConfig` and `decoRenderRouteConfig` no
 * longer exist, and there is no option to bring them back.
 *
 * @example Site's `src/routes/deco/invoke.$.ts`:
 * ```ts
 * import { createFileRoute } from "@tanstack/react-router";
 * import { decoInvokeRouteConfig } from "@decocms/tanstack";
 *
 * export const Route = createFileRoute("/deco/invoke/$")(decoInvokeRouteConfig());
 * ```
 *
 * ## Why factories and not shared config objects? (dev-HMR footgun)
 *
 * TanStack router-core's `BaseRoute.update()` MUTATES the options object it
 * receives (`Object.assign(this.options, options)` — injecting `id` and
 * `path`). Before 7.10.0 this module exported the configs as module-scope
 * LITERALS (`decoMetaRoute` / `decoRenderRoute` / `decoInvokeRoute`); a site
 * passing one by reference (`createFileRoute("/deco/invoke/$")(decoInvokeRoute)`)
 * polluted the shared literal on first execution, and any dev-server HMR
 * partial re-execution then re-ran the route file against the still-cached,
 * now-polluted literal — the route constructor threw
 * `Route cannot have both an 'id' and a 'path' option` and every route 500ed
 * until the dev server restarted. The factories hand each `createFileRoute`
 * call its own fresh object, so the mutation is harmless. The base config
 * below is module-private and deliberately NOT exported.
 */
import { corsHeaders, handleInvoke } from "@decocms/blocks-admin";
import { withTracing } from "@decocms/blocks/middleware/observability";

function invokeAttrs(request: Request): Record<string, string | boolean> {
  const url = new URL(request.url);
  const invokeKey = url.pathname.split("/deco/invoke/")[1] ?? "";
  return {
    "invoke.key": invokeKey || "(batch)",
    "invoke.batch": invokeKey === "",
  };
}

type HandlerFn = (ctx: { request: Request }) => Promise<Response> | Response;

function withCors(handler: HandlerFn): HandlerFn {
  return async (ctx) => {
    const response = await handler(ctx);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(ctx.request))) {
      headers.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  };
}

function optionsHandler(ctx: { request: Request }): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(ctx.request),
  });
}

// ---------------------------------------------------------------------------
// Base config — module-PRIVATE. Never export it: router-core's update()
// mutates whatever object createFileRoute is handed (injects id/path), so a
// shared exported literal bricks dev HMR (see module doc above). Sites get
// fresh copies via the decoInvokeRouteConfig() factory below.
// ---------------------------------------------------------------------------

/** Base config for `/deco/invoke/$` — loader/action execution. */
const decoInvokeRoute = {
  server: {
    handlers: {
      GET: withCors(({ request }) =>
        withTracing("deco.admin.invoke", () => handleInvoke(request), invokeAttrs(request)),
      ),
      POST: withCors(({ request }) =>
        withTracing("deco.admin.invoke", () => handleInvoke(request), invokeAttrs(request)),
      ),
      OPTIONS: optionsHandler,
    },
  },
};

// ---------------------------------------------------------------------------
// Factory — dev-HMR-safe route config (fresh object per call)
// ---------------------------------------------------------------------------
// Mirrors the `cmsRouteConfig()` / `cmsHomeRouteConfig()` convention in
// cmsRoute.ts: a function returning a fresh options object, so router-core's
// mutating `update()` can never pollute shared module state across HMR
// re-executions.

/**
 * Returns a fresh route config for `/deco/invoke/$` — loader/action execution.
 * Use as `createFileRoute("/deco/invoke/$")(decoInvokeRouteConfig())`.
 */
export const decoInvokeRouteConfig = () => ({ ...decoInvokeRoute });
