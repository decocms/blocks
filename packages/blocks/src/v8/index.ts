/**
 * The next-major (v8) core SDK: `createCMS`, the clients, the built-in blocks,
 * `matchRoute` and the draft helpers. Re-exported from the package root, where
 * these names are the documented ones; see /next/api-reference.
 */
export { createCMS, resetForTests } from "./cms.ts";
export {
  DRAFT_COOKIE,
  draftCookie,
  draftPointer,
  formatDraftPointer,
  parseDraftPointer,
} from "./draft.ts";
export { matchRoute } from "./matchRoute.ts";
export { remoteLoader } from "./remoteLoader.ts";
export type {
  Analytics,
  Block,
  BlockFunction,
  Blocks,
  Client,
  CMS,
  CMSError,
  DraftPointer,
  Lazy,
  ListOptions,
  Loader,
  Match,
  Page,
  Redirect,
  Result,
  Route,
  Secret,
  Seo,
  Snapshot,
  Telemetry,
  TelemetryConfig,
  Variant,
} from "./types.ts";
