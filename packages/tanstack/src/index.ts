/**
 * `@decocms/tanstack`: the names and lists the worker, the server helpers and
 * the document share, for a site that needs them in its own code (a route
 * that sets its own headers, a CSP it writes itself: `withStudioCsp` adds
 * Studio's origins to it, as the worker does). No framework imports, no
 * state: safe in every bundle.
 */
export { ASSIGNMENTS_HEADER } from "./assignments.ts";
export { type StudioCspOptions, withStudioCsp } from "./csp.ts";
export { DRAFT_COOKIE, DRAFT_PARAM, draftResponseHeaders, VERSION_HEADER } from "./draft.ts";
export {
  DEFAULT_STUDIO_ORIGINS,
  isStudioOrigin,
  STUDIO_FRAME_ANCESTORS,
  STUDIO_ORIGIN,
  STUDIO_ORIGINS,
  studioOrigins,
} from "./studio.ts";
export { VISITOR_HEADER } from "./visitor.ts";
