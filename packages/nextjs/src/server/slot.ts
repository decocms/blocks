/**
 * The draft a request renders, and the visitor's A/B assignments, held for
 * the request's Server Components. React's `cache()` gives one slot per
 * request in the React Server Components graph, the scope a draft needs; no
 * `next/headers` here, so the root components can read it without binding
 * anything.
 */
import { cache } from "react";

export const draftSlot = cache(
  (): { pointer: string | null; assignments: Record<string, boolean> | null } => ({
    pointer: null,
    assignments: null,
  }),
);

/** The draft pointer bound to this request (`bindDraft`), or `null` when it renders the release. */
export function activeDraftPointer(): string | null {
  return draftSlot().pointer;
}
