/**
 * Server-only helpers for a site's server functions and page loader. Never
 * import this from a component that ships to the browser.
 *
 * The draft a request renders is decided once, by `createDecoWorker` (its host
 * allowlist), and handed to the app in the `x-deco-draft` request header; the
 * worker removes any copy that arrives from outside. These read that header.
 */
import { type Client, type CMS, DRAFT_HEADER } from "@decocms/blocks";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";

/** The draft `request` renders (checked by the worker), or `null` for the release. */
export function requestDraft(request: Request = getRequest()): string | null {
  return request.headers.get(DRAFT_HEADER) || null;
}

/**
 * The content client for a request: its draft's, or the release's. Without
 * `request`, the request being served (`getRequest()`).
 */
export function contentClient(cms: CMS, request: Request = getRequest()): Client {
  const pointer = requestDraft(request);
  return pointer ? cms.forDraft(pointer) : cms.forRelease();
}

/** True when the browser called a server function over HTTP; false while a document renders. */
export function isServerFnCall(request: Request = getRequest()): boolean {
  return new URL(request.url).pathname.startsWith("/_serverFn/");
}

/**
 * Marks a server function's response as per-visitor (`Cache-Control: private,
 * no-store`): the worker never stores it and the CDN never keeps it. Only when
 * the browser called the function over HTTP; while a document renders the
 * function is a plain call and the header would land on the page.
 */
export function markPrivate(): void {
  if (!isServerFnCall()) return;
  setResponseHeader("Cache-Control", "private, no-store");
}

export { DEGRADED_HEADER, PAGE_STATUS_HEADER } from "../shared.ts";
