/**
 * `@decocms/nextjs`: the components a Next.js App Router site adds, and the
 * names and lists the proxy, the pages and `withDeco()` share.
 *
 * - `DraftPreviewIndicator`: the "Preview mode" badge on a page rendered from
 *   a draft (`bindDraft` from `@decocms/nextjs/server`), outside Studio's frame.
 * - `StudioBridge`: one line in the root layout, `<StudioBridge site="my-store" />`,
 *   lets Studio's site editor drive the page when Studio frames it
 *   (`@decocms/blocks/preview`'s, answering `STUDIO_ORIGINS`). It renders an
 *   inline script with no React hooks, so a Server Component renders it as is.
 *   Outside Studio's frame, "." opens the page in Studio's editor.
 * - `StudioPage`: rendered inside each CMS page, `<StudioPage pathTemplate={page.path} />`,
 *   tells the bridge which page "." opens (the root layout doesn't re-render per page).
 * - `DRAFT_PARAM`, `DRAFT_COOKIE`, `VERSION_HEADER`, `draftResponseHeaders`,
 *   `VISITOR_HEADER`, `ASSIGNMENTS_HEADER`,
 *   `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS`, `isStudioOrigin`: for a site
 *   that needs them in its own code (a route that sets its own headers, a CSP
 *   it writes itself). The package's own copy: it never imports
 *   `@decocms/tanstack`.
 *
 * The proxy (`/proxy`), the pages (`/server`), `next.config` (`/config`) and the
 * image loader (`/image-loader`) are separate subpaths, so the proxy never
 * loads React.
 */

export { DraftBadge, StudioPage, type StudioPageInfo } from "@decocms/blocks/preview";
export { ASSIGNMENTS_HEADER } from "./assignments.ts";
export {
  DraftPreviewIndicator,
  type DraftPreviewIndicatorProps,
} from "./DraftPreviewIndicator.tsx";
export { DRAFT_COOKIE, DRAFT_PARAM, draftResponseHeaders, VERSION_HEADER } from "./draft.ts";
export { StudioBridge, type StudioBridgeProps } from "./StudioBridge.ts";
export { isStudioOrigin, STUDIO_FRAME_ANCESTORS, STUDIO_ORIGINS } from "./studio.ts";
export { VISITOR_HEADER } from "./visitor.ts";
