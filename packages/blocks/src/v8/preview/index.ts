/**
 * `@decocms/blocks/preview`: the two pieces of the page that serve Deco
 * Studio and draft previews, with no framework code. `@decocms/tanstack`'s
 * document mounts both; a Next.js site adds them to its root layout.
 *
 * - `DraftBadge`: the "Preview mode" badge on a page rendered from a draft,
 *   outside Studio's frame.
 * - `StudioBridge`: lets Studio's site editor drive the page when Studio
 *   frames it.
 */
export { DraftBadge, type DraftBadgeProps } from "./DraftBadge.tsx";
export { StudioBridge, type StudioBridgeProps } from "./StudioBridge.ts";
