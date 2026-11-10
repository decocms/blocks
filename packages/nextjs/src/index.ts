/**
 * `@decocms/nextjs`: the components a Next.js App Router site adds, and the
 * names and lists the proxy, the pages and `withDeco()` share.
 *
 * - `DraftPreviewIndicator`: the "Preview mode" badge on a page rendered from
 *   a draft (`bindDraft` from `@decocms/nextjs/server`), outside Studio's frame.
 * - `StudioBridge`: one line in the root layout, `<StudioBridge site="my-store" />`,
 *   lets Studio's site editor drive the page when Studio frames it: it mounts
 *   the Studio channel (`StudioChannel` of `@decocms/blocks/preview`), through
 *   which Studio loads its own modules into the page (`studioOrigins`).
 *   Outside Studio's frame, "." opens the page in Studio's editor. Two inline
 *   scripts with no React hooks, so a Server Component renders it as is.
 * - `StudioPage`: rendered inside each CMS page, `<StudioPage pathTemplate={page.path} />`,
 *   tells the bridge which page "." opens (the root layout doesn't re-render per page).
 * - `DRAFT_PARAM`, `DRAFT_COOKIE`, `VERSION_HEADER`, `draftResponseHeaders`,
 *   `VISITOR_HEADER`, `ASSIGNMENTS_HEADER`,
 *   `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS`, `isStudioOrigin`,
 *   `STUDIO_ORIGIN`, `DEFAULT_STUDIO_ORIGINS`, `studioOrigins`: for a site
 *   that needs them in its own code (a route that sets its own headers, a CSP
 *   it writes itself). The package's own copy: it never imports
 *   `@decocms/tanstack`.
 *
 * - `withStudioCsp(directives)`: the site's CSP with Studio's origins added to
 *   `script-src` (the Studio channel's modules) and `frame-ancestors` (when it
 *   has none), the same list the Studio channel trusts.
 *
 * The proxy (`/proxy`), the pages (`/server`), `next.config` (`/config`) and the
 * image loader (`/image-loader`) are separate subpaths, so the proxy never
 * loads React.
 */

export { DraftBadge, StudioPage, type StudioPageInfo } from "@decocms/blocks/preview";
export { ASSIGNMENTS_HEADER } from "./assignments.ts";
export { type StudioCspOptions, withStudioCsp } from "./csp.ts";
export {
  DraftPreviewIndicator,
  type DraftPreviewIndicatorProps,
} from "./DraftPreviewIndicator.tsx";
export { DRAFT_COOKIE, DRAFT_PARAM, draftResponseHeaders, VERSION_HEADER } from "./draft.ts";
export { StudioBridge, type StudioBridgeProps } from "./StudioBridge.ts";
export {
  DEFAULT_STUDIO_ORIGINS,
  isStudioOrigin,
  STUDIO_FRAME_ANCESTORS,
  STUDIO_ORIGIN,
  STUDIO_ORIGINS,
  studioOrigins,
} from "./studio.ts";
export { VISITOR_HEADER } from "./visitor.ts";
