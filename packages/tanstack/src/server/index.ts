/**
 * Server-only helpers for a site's server functions and page loader. Never
 * import this from a component that ships to the browser.
 *
 * What a request reads is decided once, by `createDecoWorker`, and handed to
 * the app in request headers the worker removes when they arrive from
 * outside: the version on `x-deco-draft` (a Studio link's draft or old
 * release, after the host allowlist) and the visitor on `x-deco-visitor`
 * (`readVisitor` from `@decocms/blocks/experiments`). These read them, and
 * `contentClient` builds `cms.client({ visitor, version })` from them.
 */
import type { Client, CMS } from "@decocms/blocks";
import { parseVisitor, type Visitor } from "@decocms/blocks/experiments";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { DRAFT_HEADER } from "../draft.ts";
import { VISITOR_HEADER } from "../visitor.ts";

/**
 * The version `request` renders (a Studio link's draft pointer or release
 * SHA, checked by the worker), or `null` for the current release.
 */
export function requestDraft(request: Request = getRequest()): string | null {
  return request.headers.get(DRAFT_HEADER) || null;
}

/**
 * The visitor the worker read for `request`, or `null` when there is none (a
 * request that didn't come through `createDecoWorker`): every test is off.
 */
export function requestVisitor(request: Request = getRequest()): Visitor | null {
  return parseVisitor(request.headers.get(VISITOR_HEADER));
}

/**
 * The content client for a request: `cms.client({ visitor, version })` with
 * the visitor and the version the worker handed the app, so the built-in
 * `split-traffic` decides this visitor's tests and a preview reads its draft
 * or old release. Create one per request. Without `request`, the request
 * being served (`getRequest()`).
 */
export function contentClient(cms: CMS, request: Request = getRequest()): Client {
  return cms.client({ visitor: requestVisitor(request), version: requestDraft(request) });
}

/** True when the browser called a server function over HTTP; false while a document renders. */
export function isServerFnCall(request: Request = getRequest()): boolean {
  return new URL(request.url).pathname.startsWith("/_serverFn/");
}

/**
 * Marks a server function's response as per-visitor (`Cache-Control: private,
 * no-store`): a site's page cache never stores it (the README's recipe) and
 * the CDN never keeps it. Only when
 * the browser called the function over HTTP; while a document renders the
 * function is a plain call and the header would land on the page.
 */
export function markPrivate(): void {
  if (!isServerFnCall()) return;
  setResponseHeader("Cache-Control", "private, no-store");
}

export { DEGRADED_HEADER, PAGE_STATUS_HEADER } from "../shared.ts";
