/**
 * `@decocms/blocks/preview`: the two pieces of the page that serve Deco
 * Studio and draft previews, with no framework code. `@decocms/tanstack`'s
 * document mounts both; a Next.js site adds them to its root layout.
 *
 * - `DraftBadge`: the "Preview mode" badge on a page rendered from a draft,
 *   outside Studio's frame.
 * - `StudioBridge`: lets Studio's site editor drive the page when Studio
 *   frames it, and opens the page in Studio on "." when it isn't framed.
 * - `StudioPage`: what a page renders to tell the bridge which page it is.
 */
export { DraftBadge, type DraftBadgeProps } from "./DraftBadge.tsx";
export {
  StudioBridge,
  type StudioBridgeProps,
  StudioPage,
  type StudioPageInfo,
} from "./StudioBridge.ts";
