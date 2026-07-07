import {
  handleDecofileRead,
  handleDecofileReload,
  handleInvoke,
  handleMeta,
  handleRender,
} from "@decocms/admin";

/** For app/live/_meta/route.ts: `export { metaGET as GET } from "@decocms/next"` */
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
