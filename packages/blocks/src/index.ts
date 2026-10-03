// @decocms/blocks — framework-agnostic core
export * from "./cms/index";
export * from "./hooks/index";
export * from "./middleware/index";
// Observability surface — logger + instrumentWorker live behind their own
// granular imports too (see `@decocms/blocks/sdk/logger`, `.../observability`).
export { type Logger, type LogLevel, logger, setLogLevel } from "./sdk/logger";
export * from "./types/index";

// Next major (v8) core SDK. Explicit re-exports shadow the star exports above,
// so where v7 and v8 share a name (`DraftPointer`, `parseDraftPointer`) the
// root serves the v8 one; v7's stays reachable at `@decocms/blocks/cms`.
export {
  type Analytics,
  type Block,
  type BlockFunction,
  type Blocks,
  type Client,
  type CMS,
  type CMSConfig,
  type CMSError,
  type CMSErrorCode,
  createCMS,
  DRAFT_COOKIE,
  type DraftPointer,
  draftCookie,
  draftPointer,
  formatDraftPointer,
  HOSTED_ANALYTICS_COLLECTOR,
  type Lazy,
  type LegacyRedirect,
  type ListOptions,
  type Loader,
  type Match,
  type MatchRouteOptions,
  matchRoute,
  type Page,
  parseDraftPointer,
  type Redirect,
  type RedirectStatus,
  type RequestLike,
  type ResolveOptions,
  type Result,
  type Route,
  remoteLoader,
  resetForTests,
  type Secret,
  type Seo,
  type Snapshot,
  type Telemetry,
  type TelemetryConfig,
  type Variant,
} from "./v8/index";
