/**
 * `@decocms/nextjs`: the components a Next.js App Router site adds.
 *
 * - `DraftPreviewIndicator`: the "Preview mode" badge on a page rendered from
 *   a draft (`bindDraft` from `@decocms/nextjs/server`), outside Studio's frame.
 * - `StudioBridge` (from `@decocms/blocks/preview`): one line in the root
 *   layout, `<StudioBridge site="my-store" />`, lets Studio's site editor drive
 *   the page when Studio frames it. It renders an inline script with no React
 *   hooks, so a Server Component renders it as is.
 *
 * The proxy (`/proxy`), the pages (`/server`), `next.config` (`/config`) and the
 * image loader (`/image-loader`) are separate subpaths, so the proxy never
 * loads React.
 */

export { DraftBadge, StudioBridge, type StudioBridgeProps } from "@decocms/blocks/preview";
export {
  DraftPreviewIndicator,
  type DraftPreviewIndicatorProps,
} from "./DraftPreviewIndicator.tsx";
