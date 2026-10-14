/**
 * The "Preview mode" badge for the request's draft: a Server Component that
 * renders `DraftBadge` (`@decocms/blocks/preview`) only when `bindDraft`
 * bound a draft, so a published page emits nothing.
 *
 * Render it inside the page, after `bindDraft` was awaited, never from a
 * layout: a layout renders alongside the page that fills it, so it may run
 * before the page bound its draft.
 */
import { DraftBadge } from "@decocms/blocks/preview";
import type { ReactNode } from "react";
import { activeDraftPointer } from "./server/slot.ts";

export interface DraftPreviewIndicatorProps {
  /** Where "Exit preview" goes; default: the current URL with `?__draft=off`. */
  exitHref?: string;
}

export function DraftPreviewIndicator({ exitHref }: DraftPreviewIndicatorProps = {}): ReactNode {
  const pointer = activeDraftPointer();
  if (!pointer) return null;
  return <DraftBadge pointer={pointer} exitHref={exitHref} />;
}
