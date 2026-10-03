/**
 * `@decocms/blocks/protocol`: the content protocol's method types, errors,
 * client and file-name rule. Browser-safe.
 *
 * The protocol is how the site editor reads and writes saved blocks without
 * running a site's code: JSON-RPC 2.0 over one HTTP endpoint with four
 * methods — `describe`, `schema.get`, `blocks.list` and `blocks.apply`.
 *
 * Subpaths:
 * - `@decocms/blocks/protocol/keys` — the file-name rule (also re-exported here)
 * - `@decocms/blocks/protocol/server` — `createContentHandler(storage)`
 * - `@decocms/blocks/protocol/storage/fs` — the filesystem storage (Node only)
 * - `@decocms/blocks/protocol/storage/memory` — an in-memory storage (tests, reference)
 * - `@decocms/blocks/protocol/conformance` — a black-box test suite over HTTP
 *
 * The SDK's runtime never imports the protocol, so it never reaches an app bundle.
 */
export {
  APPLY_DIGEST_DOMAIN,
  applyRequestDigest,
  CanonicalJsonError,
  canonicalJson,
  sha256Hex,
} from "./canonical";
export {
  type BatchCall,
  type BatchOutcome,
  type ContentClient,
  type ContentClientOptions,
  createContentClient,
} from "./client";
export * from "./errors";
export * from "./keys";
export {
  CIPHERTEXT_PATTERN,
  checkSecrets,
  isSecretBlock,
  isSecretFieldSchema,
  isWellFormedCiphertext,
  SECRET_BLOCK_TYPE,
  SECRET_FORMAT,
} from "./secrets";
export * from "./storage";
export * from "./types";
