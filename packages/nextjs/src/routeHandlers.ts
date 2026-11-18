/**
 * Admin Route Handlers for Next.js App Router.
 *
 * IMPORT THESE FROM `@decocms/nextjs/routeHandlers` IN ROUTE FILES — never
 * from the `@decocms/nextjs` root barrel. Route handlers (app router
 * route.ts files) evaluate their whole module graph against React's
 * react-server build and IGNORE `"use client"` directives (there is no
 * client graph to move a module into). The root barrel also exports the
 * render components (SectionRenderer, DecoRootLayout, ...), whose graph
 * reaches `@decocms/blocks/hooks` — files with module-scope client-React
 * usage (e.g. `class ... extends Component`) that the react-server build
 * does not export. Importing the root barrel from a route file therefore
 * crashes at module evaluation ("...createContext is not a function" /
 * "Class extends value undefined is not a constructor") before the handler
 * ever runs. This subpath keeps the route-handler graph free of all
 * component code.
 *
 * SURFACE: only `/deco/invoke/*` (POST) is served. The staff-only Studio
 * admin routes — `/.decofile`, `/live/_meta`, `/deco/meta`, `/deco/render`,
 * `/live/previews/*`, `/deco/previews/*`, the `/deco/preview` page, and
 * `/live/inspect/*` / `/deco/inspect/*` — were hard-removed: they exposed
 * the site's full decofile and block schema to anyone who requested them.
 * There is deliberately no option to turn them back on.
 */
import { corsHeaders, handleInvoke } from "@decocms/blocks-admin";

/**
 * Stamp the admin CORS headers onto a handler response. The Studio is a
 * cross-origin browser client (decocms.com / admin.deco.cx calling the
 * site's /deco/invoke/*), and its JSON POSTs are non-simple requests, so
 * they preflight. Response headers can be immutable (e.g. a cached/replayed
 * body) — fall back to cloning.
 */
function withCors(request: Request, response: Response): Response {
  const cors = corsHeaders(request);
  try {
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** Answer a CORS preflight for the invoke endpoint. */
function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/** For app/deco/invoke/[...key]/route.ts */
export async function invokePOST(request: Request): Promise<Response> {
  return withCors(request, await handleInvoke(request));
}

export interface DecoRouteHandlersOptions {
  /**
   * Site bootstrap, awaited before every admin request — pass the
   * ensureSetup returned by createNextSetup (@decocms/nextjs/setup).
   */
  setup?: () => Promise<void>;
}

function notFound(pathname: string): Response {
  return new Response(JSON.stringify({ error: `Unknown deco route: ${pathname}` }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Catch-all dispatcher for the deco route segment. Mount at
 * `app/deco/[[...deco]]/route.ts`:
 *
 * ```ts
 * import { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";
 * import { ensureSetup } from "../../../deco/setup";
 * export const dynamic = "force-dynamic";
 * export const { GET, POST, OPTIONS } = createDecoRouteHandlers({
 *   setup: ensureSetup,
 * });
 * ```
 *
 * Only `/deco/invoke/*` is served; every other path under `/deco/` 404s.
 */
export function createDecoRouteHandlers(options: DecoRouteHandlersOptions = {}): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  OPTIONS(request: Request): Promise<Response>;
} {
  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/deco/invoke/")) return notFound(url.pathname);

    // CORS preflight: answer before setup — preflights carry no work and
    // must not pay (or fail on) the site bootstrap.
    if (request.method === "OPTIONS") return preflight(request);

    // POST only: handleInvoke has no auth of its own and falls back to a
    // `?props=<json>` query string for GET requests. A GET is a CORS
    // "simple request" (no preflight), so an unauthenticated
    // `<img src="https://site/deco/invoke/site/actions/...?props=...">`
    // on a third-party page would be able to trigger mutating VTEX
    // actions cross-site (CSRF).
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed: invoke is POST-only (CSRF protection)" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: "POST" },
        },
      );
    }
    await options.setup?.();
    return handleInvoke(request);
  }

  async function dispatchWithCors(request: Request): Promise<Response> {
    return withCors(request, await dispatch(request));
  }

  return { GET: dispatchWithCors, POST: dispatchWithCors, OPTIONS: dispatchWithCors };
}
