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
 */
import {
  handleDecofileRead,
  handleDecofileReload,
  handleInvoke,
  handleMeta,
  handleRender,
} from "@decocms/blocks-admin";

/** For app/live/_meta/route.ts: `export { metaGET as GET } from "@decocms/nextjs/routeHandlers"` */
export async function metaGET(request: Request): Promise<Response> {
  return handleMeta(request);
}

/** For app/.decofile/route.ts (or an equivalent rewritten path — Next.js route
 * segments can't literally start with a dot; see Task 9's fixture for the
 * rewrite-rule workaround). */
export async function decofileGET(): Promise<Response> {
  return handleDecofileRead();
}

export async function decofilePOST(request: Request): Promise<Response> {
  return handleDecofileReload(request);
}

/** For app/deco/invoke/[...key]/route.ts */
export async function invokePOST(request: Request): Promise<Response> {
  return handleInvoke(request);
}

/** For app/live/previews/[...path]/route.ts */
export async function renderGET(request: Request): Promise<Response> {
  return handleRender(request);
}

export async function renderPOST(request: Request): Promise<Response> {
  return handleRender(request);
}

export interface DecoRouteHandlersOptions {
  /**
   * Site bootstrap, awaited before every admin request — pass the
   * ensureSetup returned by createNextSetup (@decocms/nextjs/setup).
   */
  setup?: () => Promise<void>;
}

/**
 * Single catch-all dispatcher for the whole Studio admin protocol. Mount
 * at `app/deco/[[...deco]]/route.ts` and wrap next.config with
 * `withDeco()` (@decocms/nextjs/config), whose rewrites map the protocol
 * URLs Next can't express as segments (`/.decofile`, `/live/_meta`,
 * `/live/previews/*`) into `/deco/*`:
 *
 * ```ts
 * import { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";
 * import { ensureSetup } from "../../../deco/setup";
 * export const dynamic = "force-dynamic";
 * export const { GET, POST } = createDecoRouteHandlers({ setup: ensureSetup });
 * ```
 *
 * `resolveAction` accepts BOTH the rewrite's public source path (e.g.
 * `/.decofile`, `/live/_meta`, `/live/previews/*`) AND the rewrite's own
 * destination path (`/deco/*`) — not just the latter. This is load-bearing:
 * verified empirically against a real `next build && next start` (both
 * dev and production servers) that a Next.js App Router route handler
 * reached via a `next.config.js`-level `rewrites()` entry sees
 * `request.url` (and `NextRequest.nextUrl.pathname`) as the ORIGINAL,
 * pre-rewrite path the client requested — rewrites are transparent to the
 * client and, in this respect, to the handler too. Only a *direct* request
 * to `/deco/*` (bypassing the rewrite, e.g. `/deco/invoke/*`, which has no
 * public alias) arrives with a `/deco/`-prefixed pathname. Matching only
 * the `/deco/*` form (as an earlier version of this dispatcher did) makes
 * every rewritten protocol URL 404 — the dispatcher never sees a
 * `/deco/decofile`-shaped path in that case, it sees `/.decofile` verbatim.
 */
function resolveAction(pathname: string): string {
  if (pathname.startsWith("/deco/")) return pathname.slice("/deco/".length);
  if (pathname === "/.decofile") return "decofile";
  if (pathname === "/live/_meta") return "meta";
  if (pathname === "/live/previews") return "previews";
  if (pathname.startsWith("/live/previews/")) {
    return `previews/${pathname.slice("/live/previews/".length)}`;
  }
  return pathname;
}

export function createDecoRouteHandlers(options: DecoRouteHandlersOptions = {}): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
} {
  async function dispatch(request: Request): Promise<Response> {
    await options.setup?.();

    const url = new URL(request.url);
    const action = resolveAction(url.pathname);

    if (action === "decofile") {
      return request.method === "POST" ? handleDecofileReload(request) : handleDecofileRead();
    }
    if (action === "meta") {
      // GET only: this is a read-only schema endpoint, no legitimate POST use.
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method not allowed: meta is GET-only" }), {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: "GET" },
        });
      }
      return handleMeta(request);
    }
    if (action === "render") return handleRender(request);
    if (action.startsWith("invoke/")) {
      // POST only: handleInvoke has no auth of its own and falls back to a
      // `?props=<json>` query string for GET requests. A GET is a CORS
      // "simple request" (no preflight), so an unauthenticated
      // `<img src="https://site/deco/invoke/site/actions/...?props=...">`
      // on a third-party page would be able to trigger mutating VTEX
      // actions cross-site (CSRF). The per-route `invokePOST` export this
      // dispatcher replaces was POST-only for exactly this reason — keep
      // that restriction here.
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "Method not allowed: invoke is POST-only (CSRF protection)" }),
          {
            status: 405,
            headers: { "Content-Type": "application/json", Allow: "POST" },
          },
        );
      }
      return handleInvoke(request);
    }
    if (action === "previews" || action.startsWith("previews/")) {
      // handleRender parses the literal "/live/previews/" prefix.
      // `resolveAction` above already normalizes BOTH a direct
      // `/deco/previews/*` hit and a rewritten `/live/previews/*` hit down
      // to this same `action` shape, so rebuilding unconditionally here is
      // a no-op in the rewrite case (rebuilt === original) and the
      // necessary reconstruction in the direct-hit case.
      const rest = action === "previews" ? "" : action.slice("previews/".length);
      const rebuilt = new URL(url);
      rebuilt.pathname = `/live/previews/${rest}`;
      // `request` (a Request) is passed as the `init` argument here, not a
      // plain object — the Request-as-init form clones headers/method/body
      // (including the body *stream*) without needing an explicit `duplex`
      // option. Rewriting this as `new Request(rebuilt, { ...request })` or
      // any plain-object init would throw "duplex option is required" for
      // POST bodies with a body stream — see the test below that posts a
      // JSON body through this branch and asserts it still parses.
      return handleRender(new Request(rebuilt, request));
    }
    return new Response(JSON.stringify({ error: `Unknown deco route: ${url.pathname}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { GET: dispatch, POST: dispatch };
}
