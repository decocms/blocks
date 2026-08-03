/**
 * Server-side gate for the preview-mode badge.
 *
 * A Server Component (no `"use client"`) so it can read the request-scoped
 * draft pointer via `getActiveDraftPointer()` and mount the client badge ONLY
 * when a draft is actually bound — an unconfigured/published request renders
 * nothing at all.
 *
 * Placement rule (inherited from `ensureDraft`): render this INSIDE the page
 * subtree, after `ensureDraft` has been awaited — never from a layout, whose
 * children render concurrently with the page that fills the slot. Sites using
 * `createDecoPage` get it wired automatically; hand-rolled routes drop
 * `<DraftPreviewIndicator />` at the end of their page.
 */
import { DraftPreviewBadge } from "./DraftPreviewBadge";
import { getActiveDraftPointer } from "./draft";

export function DraftPreviewIndicator() {
  const pointer = getActiveDraftPointer();
  if (!pointer) return null;
  return <DraftPreviewBadge pointer={pointer} />;
}
