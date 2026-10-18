/**
 * `@decocms/tanstack`: the names and lists the worker, the server helpers and
 * the document share, for a site that needs them in its own code (a route
 * that sets its own headers, a CSP it writes itself). No imports, no state:
 * safe in every bundle.
 */
export { DRAFT_COOKIE, DRAFT_HEADER, DRAFT_PARAM, draftResponseHeaders } from "./draft.ts";
export { isStudioOrigin, STUDIO_FRAME_ANCESTORS, STUDIO_ORIGINS } from "./studio.ts";
