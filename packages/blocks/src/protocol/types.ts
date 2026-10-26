/**
 * The content protocol's method types: JSON-RPC 2.0 over one HTTP endpoint,
 * seven methods (`describe`, `schema.get`, `blocks.list`, `blocks.apply`,
 * `changes.list`, `changes.get`, `changes.discard`).
 */

export const PROTOCOL_NAME = "deco-content";

/**
 * Minors only add. A client refuses another major, and a server older than
 * `REQUIRED_PROTOCOL_MINOR`. 1.0 is `@decocms/blocks` 8.1.x and older; 1.1
 * added `changes.*`; 1.2 added overlay endpoints (`describe.overlay`), and
 * `blocks.apply` no longer reads the schema (`describe.secrets` is always
 * `null`: secrets live in the deploy platform, not in content).
 */
export const PROTOCOL_VERSION = { major: 1, minor: 2 } as const;

/**
 * The oldest minor this package's client talks to. Bump it only when the
 * client needs a newer method.
 */
export const REQUIRED_PROTOCOL_MINOR = 1;

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
  /**
   * Always `null` from protocol 1.2 on: content holds no secrets (they live
   * in the deploy platform, and the site's code passes them as params). A
   * 1.0 or 1.1 server reported `<root>/.deco/secrets.pub` here.
   */
  secrets: null | { publicKey: string };
  /**
   * `true` when the endpoint writes to an overlay over its base, such as a
   * hosted draft over the published branch (protocol 1.2). Then
   * `blocks.apply`'s `ifMatch` compares with the overlay alone: an entry the
   * overlay doesn't hold is `null`, whatever the base has, and an entry it
   * holds has the `version` `changes.list` reports for it. A deletion the
   * overlay records is held too: `changes.list` reports it as a `delete`
   * with its tombstone version, which `ifMatch` must name (`null` fails).
   * `changes.list` lists every entry the overlay holds, even one equal to the
   * base. Absent: `ifMatch` compares with the content `blocks.list` reports.
   */
  overlay?: true;
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
  /**
   * A version the entry must have; `null` = must not exist. On an overlay
   * endpoint (`describe.overlay`), the version it has in the overlay (for a
   * deletion the overlay records, its tombstone version); `null` = the
   * overlay doesn't hold it.
   */
  ifMatch?: Record<string, string | null>;
}

export interface BlocksApplyResult {
  revision: string;
  /**
   * Every name written or deleted, with its version now: `null` for a
   * deleted name, except on an overlay endpoint, where a deletion the
   * overlay records reports its tombstone version (what the next `ifMatch`
   * on it must name). An overlay may record one even for a name the base
   * lacks; a client treats it like any tombstone.
   */
  versions: Record<string, string | null>;
}

/**
 * What a source's content is compared against. A source's content is its
 * base plus its changes: `deco serve`'s base is the local git `HEAD`, the
 * site editor's hosted drafts compare with the published branch.
 */
export interface ChangesBase {
  /** An opaque revision of the base, compared only for equality (`deco serve`: the `HEAD` commit). */
  revision: string;
  /** The branch the base was read from; `null` when there's none (a detached `HEAD`). */
  resolvedRef: string | null;
}

/** One entry that differs from the base. */
export interface Change {
  /**
   * `set`: the entry exists and differs from the base, or is new. `delete`:
   * it's in the base and gone now; on an overlay endpoint, also a tombstone
   * the overlay holds for a name the base lacks (`baseVersion: null`).
   */
  kind: "set" | "delete";
  /**
   * The entry's current version, as `blocks.list` reports it (usable in
   * `ifMatch`). For a `delete`, `null`, except on an overlay endpoint
   * (`describe.overlay`), where it's the deletion's tombstone version: the
   * overlay holds the deletion, so a save of the entry must name it.
   */
  version: string | null;
  /**
   * The entry's version in the base; `null` when the base doesn't have it (a
   * new entry). Opaque: don't compare it with `version`; an entry is changed
   * because it's listed.
   */
  baseVersion: string | null;
}

export type ChangesListParams = ReadParams;

export type ChangesListResult =
  | { notModified: true; revision: string; base: ChangesBase }
  | {
      notModified: false;
      /**
       * The changes' own revision, for `ifNoneMatch`: it moves when the
       * content or the base moves. Not comparable with `blocks.list`'s.
       */
      revision: string;
      base: ChangesBase;
      /** Every entry that differs from the base, by name; an unchanged entry is absent. */
      changes: Record<string, Change>;
    };

export interface ChangesGetParams {
  /** The entries to read both sides of (at most 20). */
  names: string[];
}

/** Both sides of one entry. */
export interface ChangeDetail {
  /** `null`: the entry doesn't differ from the base, and `before` is `after`. */
  kind: "set" | "delete" | null;
  /** The entry in the base; `null` when the base doesn't have it, or it can't be read (see `diagnostics`). */
  before: Record<string, unknown> | null;
  /** The entry now; `null` when it's deleted, or it can't be read (see `diagnostics`). */
  after: Record<string, unknown> | null;
  version: string | null;
  /** For an unchanged entry, equal to `version`. */
  baseVersion: string | null;
}

/** A side `changes.get` couldn't read: as in `blocks.list`, plus which side. */
export type ChangeDiagnostic = Diagnostic & { side: "before" | "after" };

export interface ChangesGetResult {
  base: ChangesBase;
  /** Every requested name that exists in the base or now; any other name is absent. */
  entries: Record<string, ChangeDetail>;
  diagnostics: ChangeDiagnostic[];
}

export interface ChangesDiscardParams {
  /** Entries to drop back to the base. A name without a change is a no-op. */
  names: string[];
  /**
   * The version the entry must have now, as `changes.list` reports it; `null`
   * = must not exist. On an overlay endpoint, a deletion the overlay holds
   * has its tombstone version, and `null` on it fails.
   */
  ifMatch?: Record<string, string | null>;
}

/**
 * As `blocks.apply`'s result: `revision` is the content's (`blocks.list`'s)
 * revision after the discard, and `versions` every named entry's version
 * after it (`null`: not in the base), plus `null` for any other spelling the
 * discard deleted.
 */
export type ChangesDiscardResult = BlocksApplyResult;

/** The seven methods, by wire name. */
export interface Methods {
  describe: { params: Record<string, never> | undefined; result: DescribeResult };
  "schema.get": { params: SchemaGetParams | undefined; result: SchemaGetResult };
  "blocks.list": { params: BlocksListParams | undefined; result: BlocksListResult };
  "blocks.apply": { params: BlocksApplyParams; result: BlocksApplyResult };
  "changes.list": { params: ChangesListParams | undefined; result: ChangesListResult };
  "changes.get": { params: ChangesGetParams; result: ChangesGetResult };
  "changes.discard": { params: ChangesDiscardParams; result: ChangesDiscardResult };
}

export type MethodName = keyof Methods;

export const METHOD_NAMES: readonly MethodName[] = [
  "describe",
  "schema.get",
  "blocks.list",
  "blocks.apply",
  "changes.list",
  "changes.get",
  "changes.discard",
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
