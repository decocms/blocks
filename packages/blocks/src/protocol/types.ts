/**
 * The content protocol's method types: JSON-RPC 2.0 over one HTTP endpoint,
 * four methods (`describe`, `schema.get`, `blocks.list`, `blocks.apply`).
 */

export const PROTOCOL_NAME = "deco-content";

/** Minors only add; a client refuses an unknown major. */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export const SCHEMA_FORMAT = "deco-meta@1";

/**
 * The Blocks major a generated schema declares, as its top-level
 * `blocksMajor`. `deco schema` writes it and `deco check` requires it. It is
 * the package's major version, not the full version string, and it is the
 * only signal a host such as the site editor should read to tell a v8 site
 * from a v7 one: the schema's file name (`schema.gen.json` or
 * `meta.gen.json`) doesn't tell. A schema without it, or with another value,
 * is not a v8 schema.
 */
export const BLOCKS_MAJOR = 8;

/** The path the local server (`deco serve`) mounts the endpoint at. */
export const RPC_PATH = "/rpc";

/** The longest batch a request may carry. */
export const MAX_BATCH_CALLS = 10;

/** The URL prefix every uploaded asset is stored under in a field. */
export const ASSETS_URL_PREFIX = "/assets/";

export type StorageKind = "working-tree" | "git";

export interface DescribeResult {
  protocol: typeof PROTOCOL_NAME;
  version: { major: 1; minor: number };
  server: { name: string; version: string };
  /** The site editor hides publish and draft UI for a working tree. */
  kind: StorageKind;
  readOnly: boolean;
  /** The app root: the folder that contains `.deco/`, relative to the repository root. */
  root: string;
  schemaFormat: typeof SCHEMA_FORMAT;
  /** Local: 2000; git: 30000, plus on window focus. */
  pollIntervalMs: number;
  /**
   * The app the site editor shows in its Preview tab (and where "open the real
   * page" points); the local server reports `deco serve --preview`. `null`: no preview.
   */
  preview: null | { url: string };
  /** Dir relative to the repository root; `null` when read-only or uploads go to hosted storage. */
  assets: null | { dir: string; urlPrefix: typeof ASSETS_URL_PREFIX; maxBytes: number };
  /** The contents of `<root>/.deco/secrets.pub`; `null` without one. */
  secrets: null | { publicKey: string };
}

/** The schema file, in the site editor's `deco-meta@1` format. */
export interface DecoMeta {
  manifest?: { blocks?: Record<string, Record<string, unknown>> };
  schema?: { definitions?: Record<string, unknown>; root?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface ReadParams {
  ifNoneMatch?: string;
}

export type SchemaGetParams = ReadParams;

/**
 * `schema: null` (with `version: null`) means the site has no schema yet:
 * neither `.deco/schema.gen.json` nor `.deco/meta.gen.json` exists. It's a
 * normal state, not an error: `blocks.list` and `blocks.apply` work without a
 * schema, so a client still lists and edits the blocks (without typed forms)
 * and keeps polling until a schema appears. There's no version to send as
 * `ifNoneMatch`, so the poll reads it unconditionally; the answer is tiny.
 */
export type SchemaGetResult =
  | { notModified: true; version: string }
  | { notModified: false; version: string; resolvedRef: string | null; schema: DecoMeta }
  | { notModified: false; version: null; resolvedRef: string | null; schema: null };

export type BlocksListParams = ReadParams;

/** A file `blocks.list` skipped or shadowed. */
export interface Diagnostic {
  /** The file name inside `.deco/blocks`. */
  file: string;
  kind: "invalid-json" | "not-an-object" | "too-large" | "shadowed";
  message: string;
  /** For `shadowed`: the entry the file is a spelling of. */
  name?: string;
  /** For `shadowed`: the file that won. */
  winner?: string;
}

export type BlocksListResult =
  | { notModified: true; revision: string; resolvedRef: string | null }
  | {
      notModified: false;
      revision: string;
      resolvedRef: string | null;
      /** Every saved block, by name. */
      blocks: Record<string, Record<string, unknown>>;
      /** One opaque version per entry. */
      versions: Record<string, string>;
      /** Files skipped or shadowed. */
      diagnostics: Diagnostic[];
    };

export interface BlocksApplyParams {
  /** Whole-entry replace (create or update). */
  set?: Record<string, Record<string, unknown>>;
  /** A missing name counts as deleted. */
  delete?: string[];
  /** A version the entry must have; `null` = must not exist. */
  ifMatch?: Record<string, string | null>;
}

export interface BlocksApplyResult {
  revision: string;
  versions: Record<string, string | null>;
}

/** The four methods, by wire name. */
export interface Methods {
  describe: { params: Record<string, never> | undefined; result: DescribeResult };
  "schema.get": { params: SchemaGetParams | undefined; result: SchemaGetResult };
  "blocks.list": { params: BlocksListParams | undefined; result: BlocksListResult };
  "blocks.apply": { params: BlocksApplyParams; result: BlocksApplyResult };
}

export type MethodName = keyof Methods;

export const METHOD_NAMES: readonly MethodName[] = [
  "describe",
  "schema.get",
  "blocks.list",
  "blocks.apply",
];

/** A JSON-RPC request id. The protocol requires one on every request. */
export type RpcId = string | number;

export interface RpcRequest<M extends MethodName = MethodName> {
  jsonrpc: "2.0";
  id: RpcId;
  method: M;
  params?: Methods[M]["params"];
}

export type RpcResponse<R = unknown> =
  | { jsonrpc: "2.0"; id: RpcId | null; result: R }
  | { jsonrpc: "2.0"; id: RpcId | null; error: { code: number; message: string; data?: unknown } };
