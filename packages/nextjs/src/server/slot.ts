/**
 * What a request renders, held for the request's Server Components: the
 * version (a draft, or an old release, with its preview's moment and switched
 * tests and campaigns), the visitor and the tests and campaigns the proxy
 * decided. React's `cache()` gives one slot per request in the React Server
 * Components graph, the scope a draft needs; no `next/headers` here, so the
 * root components can read it without binding anything.
 */
import type { RequestVersion } from "@decocms/blocks";
import type { Visitor } from "@decocms/blocks/experiments";
import { cache } from "react";
import type { PathAssignments } from "../assignments.ts";

interface DraftSlot {
  version: RequestVersion | null;
  visitor: Visitor | null;
  assignments: PathAssignments | null;
  /** The link named a draft that can't be read anymore: the page renders the release. */
  unavailable: boolean;
}

export const draftSlot = cache(
  (): DraftSlot => ({ version: null, visitor: null, assignments: null, unavailable: false }),
);

/** The version bound to this request (`bindDraft`), or `null` when it renders the current release. */
export function activeDraftPointer(): string | null {
  return draftSlot().version?.version ?? null;
}

/** Whether the request's link named a draft that can't be read anymore (`bindDraft`). */
export function draftUnavailable(): boolean {
  return draftSlot().unavailable;
}
