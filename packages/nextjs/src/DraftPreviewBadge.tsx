"use client";

/**
 * The preview-mode badge now lives in the runtime core so both bindings share
 * one implementation — see `@decocms/blocks/preview`. This module is a thin
 * re-export kept for back-compat: sites and `DraftPreviewIndicator` import the
 * badge (and the pure `buildShareUrl`/`buildExitUrl` helpers) from here.
 * `isFramed` stays internal to `@decocms/blocks/preview` — it was never part of
 * this package's public surface.
 */
export {
  buildExitUrl,
  buildShareUrl,
  DraftPreviewBadge,
  type DraftPreviewBadgeProps,
} from "@decocms/blocks/preview";
