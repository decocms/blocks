import {
  applyDraft,
  decideDraft,
  draftRequestHeaders,
  isDraftRoutePath,
  rewriteToDraftRoute,
} from "@decocms/nextjs/proxy";
import { type NextRequest, NextResponse } from "next/server";
import { preview } from "./cms.config";
import { proxyCms } from "./cms.proxy";

export async function proxy(request: NextRequest) {
  // The draft route is reached only through the rewrite below.
  if (isDraftRoutePath(request.nextUrl.pathname)) return new NextResponse("Not found", { status: 404 });
  const draft = await decideDraft(proxyCms, request, preview);
  // Published pages are static, so a drafted request renders on the dynamic draft route.
  const response =
    rewriteToDraftRoute(request, draft) ??
    NextResponse.next({ request: { headers: draftRequestHeaders(request, draft) } });
  return applyDraft(response, draft);
}

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
