/**
 * Draft-preview constants with ZERO server imports.
 *
 * `draft.ts` statically imports `next/headers`, so anything reachable from a
 * `"use client"` file must not import from it — that would pull `next/headers`
 * into the client bundle and fail the build. The client-side badge
 * (`DraftPreviewBadge`) needs `DRAFT_PARAM` to build its links, so the shared
 * constants live here and `draft.ts` re-exports them for its own callers.
 */

/** Query param that enters draft mode (and, with `off`, leaves it). */
export const DRAFT_PARAM = "__draft";

/** Cookie that carries the pointer across in-preview navigation. */
export const DRAFT_COOKIE = "__deco_draft";

/**
 * Request header the middleware forwards the active pointer on, so the whole
 * RSC tree — including the root layout / app shell — can bind the draft on the
 * SAME request. The page reads `?__draft=` from its own `searchParams`, but a
 * layout never receives `searchParams` and, on the entry request, the cookie
 * has only just been set on the *response* (not yet readable). Forwarding the
 * pointer as a request header closes both gaps so `ensureDraft()` works from a
 * layout, letting shell-resolved Header/Footer reflect the draft too.
 *
 * Not a new trust surface: the pointer was never a secret (the draft id is the
 * capability, host-scoping bounds blast radius — see `draftSource`), so a
 * forwarded/forged header is equivalent to typing the query param.
 */
export const DRAFT_HEADER = "x-deco-draft";
