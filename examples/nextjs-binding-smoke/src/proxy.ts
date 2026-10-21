import {
  applyDraft,
  applyVisitor,
  decideDraft,
  decideVisitor,
  draftRequestHeaders,
  isDraftRoutePath,
  rewriteToDraftRoute,
  visitorRequestHeaders,
} from "@decocms/nextjs/proxy";
import { type NextRequest, NextResponse } from "next/server";
import { preview } from "./cms.config";
import { proxyCms } from "./cms.proxy";

export async function proxy(request: NextRequest) {
  // The draft route is reached only through the rewrite below.
  if (isDraftRoutePath(request.nextUrl.pathname)) return new NextResponse("Not found", { status: 404 });
  // The version: a Studio link's draft or old release, on a host that may preview.
  const draft = await decideDraft(proxyCms, request, preview);
  // The visitor: the deco_segment cookie, or a new one (its cookie goes out on a first visit).
  const visitor = decideVisitor(request, draft);
  // Published pages are static, so a drafted request renders on the dynamic draft route.
  const response =
    rewriteToDraftRoute(request, draft, visitor) ??
    NextResponse.next({
      request: { headers: visitorRequestHeaders(draftRequestHeaders(request, draft), visitor) },
    });
  return applyVisitor(applyDraft(response, draft), visitor);
}

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
