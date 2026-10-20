/**
 * Server-only helpers for a site's server functions and page loader. Never
 * import this from a component that ships to the browser.
 *
 * The draft a request renders is decided once, by `createDecoWorker` (its host
 * allowlist), and handed to the app in the `x-deco-draft` request header; the
 * worker removes any copy that arrives from outside. These read that header.
 * The visitor's A/B assignments arrive the same way, on `x-deco-assignments`
 * (set by the worker from the `Experiments` block of the release or draft
 * the request renders).
 */
import type { Client, CMS } from "@decocms/blocks";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { ASSIGNMENTS_HEADER, decodeAssignments } from "../assignments.ts";
import { DRAFT_HEADER } from "../draft.ts";

/** The draft `request` renders (checked by the worker), or `null` for the release. */
export function requestDraft(request: Request = getRequest()): string | null {
  return request.headers.get(DRAFT_HEADER) || null;
}

/**
 * The visitor's A/B assignments the worker decided for `request` (the
 * experiments they are in), or `null` when it decided none: content without
 * experiments, or a request that didn't come through `createDecoWorker`.
 */
export function requestAssignments(
  request: Request = getRequest(),
): Record<string, boolean> | null {
  const value = request.headers.get(ASSIGNMENTS_HEADER);
  return value === null ? null : decodeAssignments(value);
}

/**
 * The content client for a request: its draft's, or the release's, with the
 * visitor's A/B assignments, so the built-in `experiment` matcher answers for
 * this visitor (a draft's client also shows the variants its pointer
 * forces). Without `request`, the request being served (`getRequest()`).
 */
export function contentClient(cms: CMS, request: Request = getRequest()): Client {
  const pointer = requestDraft(request);
  const assignments = requestAssignments(request);
  if (pointer)
    return assignments === null ? cms.forDraft(pointer) : cms.forDraft(pointer, { assignments });
  return assignments === null ? cms.forRelease() : cms.forRelease({ assignments });
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
