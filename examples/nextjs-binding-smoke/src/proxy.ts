import {
  applyDraft,
  applyVisitor,
  decideDraft,
  decideVisitor,
  draftRequestHeaders,
  isAssignmentsRoutePath,
  isDraftRoutePath,
  rewriteToAssignmentsRoute,
  rewriteToDraftRoute,
  visitorRequestHeaders,
} from "@decocms/nextjs/proxy";
import { type NextRequest, NextResponse } from "next/server";
import { preview } from "./cms.config";
import { proxyCms } from "./cms.proxy";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // The draft and assignments routes are reached only through the rewrites below: a path can't
  // pick a draft, or switch a test or a campaign on.
  if (isDraftRoutePath(pathname) || isAssignmentsRoutePath(pathname)) {
    return new NextResponse("Not found", { status: 404 });
  }
  // The version: a Studio link's draft or old release, on a host that may preview.
  const draft = await decideDraft(proxyCms, request, preview);
  // The visitor: the deco_segment cookie, or a new one (its cookie goes out on a first visit).
  const visitor = decideVisitor(request, draft);
  // Published pages are static, so a drafted request renders on the dynamic draft route, and a CMS
  // page on the assignments route, /_assignments/<assignments>/<path>: Next caches one entry per set of
  // assignments, and the visitor stays out of it.
  const response =
    rewriteToDraftRoute(request, draft, visitor) ??
    (isCmsPage(pathname) ? await rewriteToAssignmentsRoute(proxyCms, request, draft, visitor) : null) ??
    NextResponse.next({
      request: { headers: visitorRequestHeaders(draftRequestHeaders(request, draft), visitor) },
    });
  return applyVisitor(applyDraft(response, draft), visitor);
}

// The routes of the app's own, outside the CMS: the blog index and the smoke's fixtures.
function isCmsPage(pathname: string): boolean {
  return pathname !== "/blog" && !pathname.startsWith("/smoke/");
}

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
