/**
 * Admin Route Helpers
 *
 * Pre-built server handler configs for the Deco admin protocol routes.
 * Sites use these in their `createFileRoute` definitions to avoid
 * repeating the same CORS + handler boilerplate.
 *
 * Prefer the `*RouteConfig()` factories — they return a FRESH options
 * object per call, which is required for dev-HMR safety (see below).
 *
 * @example Site's `src/routes/deco/meta.ts`:
 * ```ts
 * import { createFileRoute } from "@tanstack/react-router";
 * import { decoMetaRouteConfig } from "@decocms/tanstack";
 *
 * export const Route = createFileRoute("/deco/meta")(decoMetaRouteConfig());
 * ```
 *
 * ## Why factories? (dev-HMR footgun with the shared literals)
 *
 * TanStack router-core's `BaseRoute.update()` MUTATES the options object it
 * receives (`Object.assign(this.options, options)` — injecting `id` and
 * `path`). If a site passes one of the module-scope literals below by
 * reference (`createFileRoute("/deco/meta")(decoMetaRoute)`), the first
 * execution pollutes the shared literal. On any dev-server HMR partial
 * re-execution the route file re-runs against the still-cached, now-polluted
 * literal and the route constructor throws
 * `Route cannot have both an 'id' and a 'path' option` — every route 500s
 * until the dev server restarts. The factories (or spreading the literal:
 * `({ ...decoMetaRoute })`) hand each `createFileRoute` call its own object,
 * so the mutation is harmless.
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

/**
 * Route config literal for `/deco/meta` — serves JSON Schema + manifest.
 *
 * FOOTGUN: never pass this by reference (`createFileRoute(...)(decoMetaRoute)`) —
 * router-core's `update()` mutates it (injects `id`/`path`) and dev HMR then
 * bricks every route until restart. Spread it (`{ ...decoMetaRoute }`) or use
 * {@link decoMetaRouteConfig} instead.
 */
export const decoMetaRoute = {
  server: {
    handlers: {
      GET: withCors(({ request }) =>
        withTracing("deco.admin.meta", async () => handleMeta(request)),
      ),
      OPTIONS: optionsHandler,
    },
  },
};

/**
 * Route config literal for `/deco/render` — section/page preview in iframe.
 *
 * FOOTGUN: never pass this by reference (`createFileRoute(...)(decoRenderRoute)`) —
 * router-core's `update()` mutates it (injects `id`/`path`) and dev HMR then
 * bricks every route until restart. Spread it (`{ ...decoRenderRoute }`) or use
 * {@link decoRenderRouteConfig} instead.
 */
export const decoRenderRoute = {
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

/**
 * Route config literal for `/deco/invoke/$` — loader/action execution.
 *
 * FOOTGUN: never pass this by reference (`createFileRoute(...)(decoInvokeRoute)`) —
 * router-core's `update()` mutates it (injects `id`/`path`) and dev HMR then
 * bricks every route until restart. Spread it (`{ ...decoInvokeRoute }`) or use
 * {@link decoInvokeRouteConfig} instead.
 */
export const decoInvokeRoute = {
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
// re-executions. Prefer these over the literals above in site route files.

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
