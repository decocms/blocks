/**
 * The version a request renders (a draft, or an old release) and the
 * visitor, held for the request's Server Components. React's `cache()` gives
 * one slot per request in the React Server Components graph, the scope a
 * draft needs; no `next/headers` here, so the root components can read it
 * without binding anything.
 */
import type { Visitor } from "@decocms/blocks/experiments";
import { cache } from "react";

export const draftSlot = cache((): { pointer: string | null; visitor: Visitor | null } => ({
  pointer: null,
  visitor: null,
}));

/** The version bound to this request (`bindDraft`), or `null` when it renders the current release. */
export function activeDraftPointer(): string | null {
  return draftSlot().pointer;
}
