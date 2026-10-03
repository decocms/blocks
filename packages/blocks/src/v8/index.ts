/**
 * The next-major (v8) core SDK: `createCMS`, the clients, the built-in blocks,
 * `matchRoute` and the draft helpers. Re-exported from the package root, where
 * these names are the documented ones; see /next/api-reference.
 */
export { HOSTED_ANALYTICS_COLLECTOR } from "./builtins/data";
export { createCMS, resetForTests } from "./cms";
export {
  DRAFT_COOKIE,
  draftCookie,
  draftPointer,
  formatDraftPointer,
  parseDraftPointer,
  type RequestLike,
} from "./draft";
export { type MatchRouteOptions, matchRoute } from "./matchRoute";
export type {
  Analytics,
  Block,
  BlockFunction,
  Blocks,
  Client,
  CMS,
  CMSConfig,
  CMSError,
  CMSErrorCode,
  DraftPointer,
  Lazy,
  LegacyRedirect,
  ListOptions,
  Loader,
  Match,
  Page,
  Redirect,
  RedirectStatus,
  ResolveOptions,
  Result,
  Route,
  Secret,
  Seo,
  Snapshot,
  Telemetry,
  TelemetryConfig,
  Variant,
} from "./types";
