/**
 * Server-only helpers for a site's server functions and page loader. Never
 * import this from a component that ships to the browser.
 *
 * What a request reads is decided once, by `createDecoWorker`, and handed to
 * the app in request headers the worker removes when they arrive from
 * outside: the version on `x-deco-version` (a Studio link's draft or old
 * release, after the host allowlist), the visitor on `x-deco-visitor`
 * (`readVisitor` from `@decocms/blocks/experiments`) and each test and
 * campaign on or off on `x-deco-assignments`, and for a draft the release
 * check it made on `x-deco-release-check`. These read them, and
 * `contentClient` builds `cms.client({ version, releaseCheck, experiments,
 * campaigns })` from them: the page decides nothing again, and its draft
 * reads share the worker's check of the latest release.
 */
import type { Client, CMS } from "@decocms/blocks";
import { parseVisitor, type Visitor } from "@decocms/blocks/experiments";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { ASSIGNMENTS_HEADER, type DecidedAssignments, parseAssignments } from "../assignments.ts";
import { RELEASE_CHECK_HEADER, VERSION_HEADER } from "../draft.ts";
import { VISITOR_HEADER } from "../visitor.ts";

/**
 * The version `request` renders (a Studio link's draft pointer or release
 * SHA, checked by the worker), or `null` for the current release.
 */
export function requestVersion(request: Request = getRequest()): string | null {
  return request.headers.get(VERSION_HEADER) || null;
}

/**
 * The visitor the worker read for `request`, or `null` when there is none (a
 * request that didn't come through `createDecoWorker`).
 */
export function requestVisitor(request: Request = getRequest()): Visitor | null {
  return parseVisitor(request.headers.get(VISITOR_HEADER));
}

/**
 * Each test and campaign on or off as the worker decided them for `request`,
 * or `null` when it decided none (a request that didn't come through
 * `createDecoWorker`).
 */
export function requestAssignments(request: Request = getRequest()): DecidedAssignments | null {
  return parseAssignments(request.headers.get(ASSIGNMENTS_HEADER));
}

/**
 * The content client for a request: `cms.client({ version, experiments,
 * campaigns })` with what the worker decided, so the page renders the tests
 * and campaigns the worker keyed its cache on and a preview reads its draft
 * or old release. The visitor rides along (`client.visitor`) but decides
 * nothing the worker already did; without the worker's decisions (a request
 * that didn't come through it) the visitor decides. Create one per request.
 * Without `request`, the request being served (`getRequest()`).
 */
export function contentClient(cms: CMS, request: Request = getRequest()): Client {
  const decided = requestAssignments(request);
  const version = requestVersion(request);
  // The worker's release check for this draft request: the draft waits for it, never one of its own.
  const releaseCheck = version === null ? null : request.headers.get(RELEASE_CHECK_HEADER);
  return cms.client({
    version,
    ...(releaseCheck ? { releaseCheck } : {}),
    visitor: requestVisitor(request),
    experiments: decided?.experiments,
    campaigns: decided?.campaigns,
  });
}

/** True when the browser called a server function over HTTP; false while a document renders. */
export function isServerFnCall(request: Request = getRequest()): boolean {
  return new URL(request.url).pathname.startsWith("/_serverFn/");
}

/**
 * Marks a server function's response as per-visitor (`Cache-Control: private,
 * no-store`): a site's page cache never stores it (the example worker entry the README links) and
 * the CDN never keeps it. Only when
 * the browser called the function over HTTP; while a document renders the
 * function is a plain call and the header would land on the page.
 */
export function markPrivate(): void {
  if (!isServerFnCall()) return;
  setResponseHeader("Cache-Control", "private, no-store");
}

export { DEGRADED_HEADER, PAGE_STATUS_HEADER } from "../shared.ts";
