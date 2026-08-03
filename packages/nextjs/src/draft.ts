/**
 * Draft preview — the Next.js binding.
 *
 * `@decocms/blocks`'s `draftSource` owns the framework-agnostic half (pointer
 * parsing, origin construction, fetch, version cache). This file binds a
 * resolved draft to the current request.
 *
 * ## Why React `cache()` and not AsyncLocalStorage
 *
 * App Router never enters `RequestContext.run` (that is a TanStack/Workers
 * path), and ALS cannot help here anyway: you cannot wrap `ALS.run()` around a
 * component's children, because the children render later, outside the call.
 * `cache()` gives a per-request memoized value in RSC, which is exactly the
 * scope needed — verified concurrently, see `draft.test.ts`.
 *
 * ## Why this must be awaited by the PAGE, not a layout
 *
 * A layout's `await` does NOT gate its children: App Router renders a layout
 * and its children concurrently, so sections call `loadBlocks()` before a
 * layout-level resolve lands, and silently render published content. The
 * resolve has to happen somewhere that returns the subtree *after* awaiting —
 * i.e. the page component. `ensureDraft()` exists so each site makes one call
 * instead of re-deriving that ordering rule.
 */
import {
  isDraftHostAllowed,
  resolveDraftDecofile,
  setDraftOverrideGetter,
} from "@decocms/blocks/cms";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { DRAFT_COOKIE, DRAFT_PARAM } from "./draftConstants";

// Re-exported for back-compat: these used to live here, but the client badge
// needs DRAFT_PARAM and cannot import this module (it pulls in `next/headers`).
export { DRAFT_COOKIE, DRAFT_PARAM } from "./draftConstants";

/**
 * Request-scoped slot.
 *
 * `cache()` memoizes per-request, so every call within one request gets the
 * same object and a different one per request. Mutable by design: the page
 * fills it before returning its subtree, and nested sections read it
 * synchronously through `loadBlocks()`.
 *
 * `pointer` is the raw `<host>@<version>` token this render is bound to, kept
 * so the UI can surface an explicit "you are in preview" indicator and build a
 * shareable link — see {@link getActiveDraftPointer}.
 */
const draftSlot = cache((): {
  blocks: Record<string, unknown> | null;
  pointer: string | null;
} => ({
  blocks: null,
  pointer: null,
}));

/**
 * Register the request-scoped getter with the runtime.
 *
 * Idempotent and safe to call at module scope: outside a request `cache()`
 * still returns an object, whose `blocks` is null, so `loadBlocks()` sees no
 * override and behaves exactly as before.
 */
let registered = false;
export function registerDraftOverride(): void {
  if (registered) return;
  registered = true;
  setDraftOverrideGetter(() => draftSlot().blocks);
}

/** A page's `searchParams` prop, before it is narrowed. */
export type DraftSearchParams = Record<string, string | string[] | undefined>;

/** First value of a search param that may legitimately repeat. */
function firstParam(searchParams: DraftSearchParams | undefined, key: string): string | null {
  const raw = searchParams?.[key];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

/**
 * The pointer for this request: the query param wins, the cookie carries
 * navigation, `off` exits.
 *
 * Read directly from the page rather than trusted from a request header. The
 * param has to take precedence or a save would never surface — Studio
 * navigating to a new version would keep rendering whatever older pointer is
 * still sitting in the cookie.
 */
export function selectDraftPointer(
  searchParams: DraftSearchParams | undefined,
  cookieValue: string | null | undefined,
): string | null {
  const param = firstParam(searchParams, DRAFT_PARAM);
  if (param === "off") return null;
  if (param) return param;
  return cookieValue ?? null;
}

/**
 * Resolve the request's draft, if any, and bind it for the rest of the render.
 *
 * Call this from the PAGE, awaited, before returning the subtree:
 *
 * ```tsx
 * export default async function Page({ searchParams }) {
 *   await ensureDraft(await searchParams);
 *   return <DecoPageRenderer />;
 * }
 * ```
 *
 * Reads the param from the page's own `searchParams` and the cookie via
 * `cookies()`. There is deliberately no request header in the path: the page
 * owns the decision, so a draft keeps working on routes the middleware matcher
 * never sees, and there is one less forgeable input to reason about. (The
 * pointer was never a secret — the draft id (the token's authority) is the capability — so a
 * client supplying one directly is equivalent to typing the query param.)
 *
 * Returns whether a draft was bound, so callers can surface an explicit
 * "draft unavailable" state instead of silently showing published content —
 * the failure mode most likely to mislead someone reviewing their own edits.
 */
export async function ensureDraft(searchParams?: DraftSearchParams): Promise<boolean> {
  registerDraftOverride();

  const cookieStore = await cookies();
  const pointer = selectDraftPointer(searchParams, cookieStore.get(DRAFT_COOKIE)?.value);
  if (!pointer) return false;

  // Host gate, checked only once a pointer exists (headers() is a dynamic
  // API): the same build may serve the preview domain and the production
  // domain, and only hosts named in DECO_ALLOWED_PREVIEW_HOSTS may render
  // drafts — production stays published no matter what the URL carries.
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!isDraftHostAllowed(host)) return false;

  const blocks = await resolveDraftDecofile({ pointer });
  if (!blocks) return false;

  const slot = draftSlot();
  slot.blocks = blocks;
  slot.pointer = pointer;
  return true;
}

/**
 * The raw draft pointer bound to this request, or null if the request is not
 * rendering a draft.
 *
 * Synchronous — reads the same request-scoped slot `ensureDraft` fills, so it
 * must be called AFTER `ensureDraft` has been awaited in this request (i.e.
 * from inside the page subtree, not a concurrently-rendered layout). Powers
 * the preview-mode indicator: a bound pointer is the signal that the visitor
 * is looking at unpublished content, and it is exactly what a "share this
 * draft" link must carry.
 */
export function getActiveDraftPointer(): string | null {
  return draftSlot().pointer;
}

// ---------------------------------------------------------------------------
// Middleware helper
// ---------------------------------------------------------------------------

/** What middleware should do with this request. */
export interface DraftMiddlewareDecision {
  /** The active pointer, or null. Drives the cache/indexing headers. */
  pointer: string | null;
  /** Set the cookie to this value (entering draft mode). */
  setCookie: string | null;
  /** Clear the cookie (leaving draft mode via `?__draft=off`). */
  clearCookie: boolean;
}

/**
 * Decide the draft state for a request, from `?__draft=` and the cookie.
 *
 * The param is authoritative on entry and the cookie carries subsequent
 * in-preview navigation — a param alone dies on the first link click, and a
 * cookie alone cannot be relied on: the preview iframe is cross-site, so the
 * cookie is third-party and may be blocked outright (Safari ITP) or
 * partitioned (Chrome CHIPS). Entry therefore never depends on cookie support.
 *
 * `?__draft=off` leaves draft mode, so a session can be ended deliberately
 * rather than waiting for a cookie to expire.
 *
 * Pure and framework-free so it can be unit-tested without a Next request; the
 * caller applies the decision to its own `NextResponse`.
 */
export function decideDraft(
  url: URL,
  cookieValue: string | null | undefined,
): DraftMiddlewareDecision {
  const param = url.searchParams.get(DRAFT_PARAM);

  if (param === "off") {
    return { pointer: null, setCookie: null, clearCookie: true };
  }
  if (param) {
    return { pointer: param, setCookie: param, clearCookie: false };
  }
  if (cookieValue) {
    return { pointer: cookieValue, setCookie: null, clearCookie: false };
  }
  return { pointer: null, setCookie: null, clearCookie: false };
}

/**
 * Cookie attributes for the draft pointer.
 *
 * `SameSite=None; Secure` is mandatory for a cross-site iframe, and
 * `Partitioned` (CHIPS) is what keeps it working as browsers wind down
 * unpartitioned third-party cookies. Short-lived: a draft session is minutes,
 * and a stale pointer would keep pinning an old version.
 */
export const DRAFT_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  partitioned: true,
  path: "/",
  maxAge: 60 * 30,
} as const;
