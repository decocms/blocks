/**
 * The next-major (v8) core SDK: `createCMS`, the clients, the built-in blocks,
 * `matchRoute` and the draft pointer helpers (`cms.draftPointer` and
 * `cms.draftCookie` are methods: they check the preview hosts). Re-exported from the package root, where
 * these names are the documented ones; see /next/api-reference.
 */
export { createCMS, resetForTests } from "./cms.ts";
export { formatDraftPointer, parseDraftPointer } from "./draft.ts";
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
  CMSSettings,
  DraftPointer,
  EffectiveSettings,
  Lazy,
  ListOptions,
  Loader,
  Match,
  Page,
  Redirect,
  RequestLike,
  Result,
  Route,
  Secret,
  Seo,
  Snapshot,
  Telemetry,
  TelemetryConfig,
  Variant,
} from "./types.ts";
