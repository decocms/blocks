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
 */
export function createDecoRouteHandlers(options: DecoRouteHandlersOptions = {}): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
} {
  async function dispatch(request: Request): Promise<Response> {
    await options.setup?.();

    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/deco\//, "");

    if (action === "decofile") {
      return request.method === "POST" ? handleDecofileReload(request) : handleDecofileRead();
    }
    if (action === "meta") return handleMeta(request);
    if (action === "render") return handleRender(request);
    if (action.startsWith("invoke/")) return handleInvoke(request);
    if (action === "previews" || action.startsWith("previews/")) {
      // handleRender parses the literal "/live/previews/" prefix — rebuild
      // the pre-rewrite URL (rewrites hand route handlers the DESTINATION
      // path, so the prefix information is otherwise lost).
      const rest = action === "previews" ? "" : action.slice("previews/".length);
      const rebuilt = new URL(url);
      rebuilt.pathname = `/live/previews/${rest}`;
      return handleRender(new Request(rebuilt, request));
    }
    return new Response(JSON.stringify({ error: `Unknown deco route: ${url.pathname}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { GET: dispatch, POST: dispatch };
}
