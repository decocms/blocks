/**
 * The next-major (v8) core SDK: `createCMS`, the clients, `currentClient`,
 * the built-in blocks, `matchRoute` and the draft pointer helpers
 * (`cms.readVersion` and `cms.draftCookie` are methods: they check the
 * preview hosts). Re-exported from the package root, where
 * these names are the documented ones; see /next/api-reference.
 */
export { createCMS, resetForTests } from "./cms.ts";
export { currentClient } from "./current.ts";
export { formatDraftPointer, parseDraftPointer, parseVersion } from "./draft.ts";
export { matchRoute } from "./matchRoute.ts";
export { remoteLoader } from "./remoteLoader.ts";
export type {
  Analytics,
  Block,
  BlockFunction,
  Blocks,
  Client,
  ClientOptions,
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
  RequestVersion,
  Result,
  Route,
  Seo,
  Snapshot,
  Telemetry,
  TelemetryConfig,
  Variant,
} from "./types.ts";
