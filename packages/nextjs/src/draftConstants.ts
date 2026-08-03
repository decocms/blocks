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
