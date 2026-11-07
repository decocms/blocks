/**
 * `@decocms/blocks/protocol`: the content protocol's method types, errors,
 * client and file-name rule. Browser-safe.
 *
 * The protocol is how the site editor reads and writes saved blocks without
 * running a site's code: JSON-RPC 2.0 over one HTTP endpoint with seven
 * methods — `describe`, `schema.get`, `blocks.list`, `blocks.apply`, and
 * `changes.list`, `changes.get` and `changes.discard` (protocol 1.1: what
 * differs from the base, both sides of an entry, and dropping a change).
 *
 * Subpaths:
 * - `@decocms/blocks/protocol/keys` — the file-name rule (also re-exported here)
 * - `@decocms/blocks/protocol/server` — `createContentHandler(storage)`
 * - `@decocms/blocks/protocol/storage/fs` — the filesystem storage (Node only)
 * - `@decocms/blocks/protocol/conformance` — a black-box test suite over HTTP
 *
 * The Studio channel's messages (`deco:ready`, `deco:load`, ...) and the
 * context a Studio module gets are here too (`./channel.ts`):
 * the page's bootstrap is `StudioChannel` in `@decocms/blocks/preview`.
 *
 * `blockMeta`/`indexEntry` compute a hosted revision index's entries (the
 * SDK's own browser-safe module, shared with Studio and the CLI).
 *
 * The SDK's runtime never imports the protocol, so it never reaches an app
 * bundle. The canonical hash it re-exports is the SDK's own dependency-free
 * leaf module (see ./canonical.ts). Draft previews and the draft lifecycle
 * are outside the protocol (see /next/content-delivery#draft-previews).
 */

export {
  type BlockIndex,
  type BlockMeta,
  blockMeta,
  type IndexEntry,
  indexEntry,
} from "../v8/blockMeta.ts";
export { isRevisionId, REVISION_ID_RE } from "../v8/revisionId.ts";
export {
  blockVersion,
  CanonicalJsonError,
  CONTENT_HASH_FORMAT,
  canonicalJson,
  computeContentRevision,
  sha256Hex,
} from "./canonical.ts";
export {
  CHANNEL_MESSAGE,
  type ChannelLoadErrorMessage,
  type ChannelLoadedMessage,
  type ChannelLoadMessage,
  type ChannelReadyMessage,
  DEFAULT_STUDIO_ORIGIN,
  DEFAULT_STUDIO_ORIGINS,
  defineStudioModule,
  type ModuleMessage,
  type PageChannelMessage,
  type StudioChannelContext,
  type StudioChannelMessage,
  type StudioChannelModule,
} from "./channel.ts";
export {
  assertSupportedEndpoint,
  type BatchCall,
  type BatchOutcome,
  type ContentClient,
  type ContentClientOptions,
  createContentClient,
} from "./client.ts";
export * from "./errors.ts";
export * from "./keys.ts";
export * from "./storage.ts";
export * from "./types.ts";
