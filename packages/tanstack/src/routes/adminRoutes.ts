/**
 * Admin Route Helpers
 *
 * Pre-built server handler config factories for the Deco admin protocol
 * routes. Sites call these in their `createFileRoute` definitions to avoid
 * repeating the same CORS + handler boilerplate.
 *
 * @example Site's `src/routes/deco/meta.ts`:
 * ```ts
 * import { createFileRoute } from "@tanstack/react-router";
 * import { decoMetaRouteConfig } from "@decocms/tanstack";
 *
 * export const Route = createFileRoute("/deco/meta")(decoMetaRouteConfig());
 * ```
 *
 * ## Why factories and not shared config objects? (dev-HMR footgun)
 *
 * TanStack router-core's `BaseRoute.update()` MUTATES the options object it
 * receives (`Object.assign(this.options, options)` — injecting `id` and
 * `path`). Before 7.10.0 this module exported the configs as module-scope
 * LITERALS (`decoMetaRoute` / `decoRenderRoute` / `decoInvokeRoute`); a site
 * passing one by reference (`createFileRoute("/deco/meta")(decoMetaRoute)`)
 * polluted the shared literal on first execution, and any dev-server HMR
 * partial re-execution then re-ran the route file against the still-cached,
 * now-polluted literal — the route constructor threw
 * `Route cannot have both an 'id' and a 'path' option` and every route 500ed
 * until the dev server restarted. The factories hand each `createFileRoute`
 * call its own fresh object, so the mutation is harmless. The base configs
 * below are module-private and deliberately NOT exported.
 */
import { corsHeaders, handleInvoke, handleMeta, handleRender } from "@decocms/blocks-admin";
import { withTracing } from "@decocms/blocks/sdk/observability";

function invokeAttrs(request: Request): Record<string, string | boolean> {
  const url = new URL(request.url);
  const invokeKey = url.pathname.split("/deco/invoke/")[1] ?? "";
  return {
    "invoke.key": invokeKey || "(batch)",
    "invoke.batch": invokeKey === "",
  };
}

function renderAttrs(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const pathComponent = url.pathname.split("/deco/render/")[1] ?? "";
  return { "cms.component": pathComponent || "(page)" };
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
// Base configs — module-PRIVATE. Never export these: router-core's update()
// mutates whatever object createFileRoute is handed (injects id/path), so a
// shared exported literal bricks dev HMR (see module doc above). Sites get
// fresh copies via the *RouteConfig() factories below.
// ---------------------------------------------------------------------------

/** Base config for `/deco/meta` — serves JSON Schema + manifest. */
const decoMetaRoute = {
  server: {
    handlers: {
      GET: withCors(({ request }) =>
        withTracing("deco.admin.meta", async () => handleMeta(request)),
      ),
      OPTIONS: optionsHandler,
    },
  },
};

/** Base config for `/deco/render` — section/page preview in iframe. */
const decoRenderRoute = {
  server: {
    handlers: {
      GET: withCors(({ request }) =>
        withTracing(
          "deco.admin.render",
          () => Promise.resolve(handleRender(request)),
          renderAttrs(request),
        ),
      ),
      POST: withCors(({ request }) =>
        withTracing(
          "deco.admin.render",
          () => Promise.resolve(handleRender(request)),
          renderAttrs(request),
        ),
      ),
      OPTIONS: optionsHandler,
    },
  },
};

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
// Factories — dev-HMR-safe route configs (fresh object per call)
// ---------------------------------------------------------------------------
// Mirrors the `cmsRouteConfig()` / `cmsHomeRouteConfig()` convention in
// cmsRoute.ts: a function returning a fresh options object, so router-core's
// mutating `update()` can never pollute shared module state across HMR
// re-executions.

/**
 * Returns a fresh route config for `/deco/meta` — serves JSON Schema + manifest.
 * Use as `createFileRoute("/deco/meta")(decoMetaRouteConfig())`.
 */
export const decoMetaRouteConfig = () => ({ ...decoMetaRoute });

/**
 * Returns a fresh route config for `/deco/render` — section/page preview in iframe.
 * Use as `createFileRoute("/deco/render")(decoRenderRouteConfig())`.
 */
export const decoRenderRouteConfig = () => ({ ...decoRenderRoute });

/**
 * Returns a fresh route config for `/deco/invoke/$` — loader/action execution.
 * Use as `createFileRoute("/deco/invoke/$")(decoInvokeRouteConfig())`.
 */
export const decoInvokeRouteConfig = () => ({ ...decoInvokeRoute });
