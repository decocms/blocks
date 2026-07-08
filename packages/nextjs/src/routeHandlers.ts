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
