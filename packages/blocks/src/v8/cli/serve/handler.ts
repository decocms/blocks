/**
 * The content protocol over one `ContentStorage`: JSON-RPC 2.0, four methods
 * (spec: content-protocol › The wire format).
 *
 * TODO(N-01): `@decocms/blocks/protocol/server` exports
 * `createContentHandler(storage): (Request) => Response`, the shared core
 * every backend uses (batching, limits, validation, the secret guard). This
 * is the local server's minimal implementation of the same contract with the
 * same signature; when N-01 lands, replace `createLocalContentHandler` with
 * it, keep `describe` options as its config, and run its conformance suite
 * against `deco serve`.
 */
import { secretViolations } from "../check/index";
import { invalidNameReason } from "../keys";
import type { DecoMeta } from "../schema/generate";
import { SCHEMA_FORMAT } from "../schema/generate";
import type { ApplyResult, ContentStorage } from "./storage";
import { serializeEntry } from "./storage";

export const ERRORS = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  NotFound: -32001,
  Conflict: -32002,
  InvalidBlock: -32003,
  ReadOnly: -32005,
  Unsupported: -32006,
  LimitExceeded: -32007,
  Unavailable: -32008,
  Unauthorized: -32010,
  Forbidden: -32011,
} as const;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const DEFAULT_LIMITS = {
  maxOpsPerApply: 500,
  maxBlockBytes: 1024 * 1024,
  maxRequestBytes: 8 * 1024 * 1024,
  maxListBytes: 64 * 1024 * 1024,
  maxSchemaBytes: 32 * 1024 * 1024,
  maxBatchResponseBytes: 96 * 1024 * 1024,
};

const MAX_BATCH = 10;
const POLL_INTERVAL_MS = 2000;

export interface HandlerOptions {
  readOnly: boolean;
  /** The app root, relative to the repository root. */
  root: string;
  serverVersion: string;
  /** Where "open the real page" points: the dev app. */
  previewOrigin: string | null;
  assets: null | { dir: string; maxBytes: number };
  /** The contents of `.deco/secrets.pub`, read on each describe. */
  secretsPublicKey: () => string | null;
  limits?: typeof DEFAULT_LIMITS;
  /** Called after every successful `blocks.apply`. */
  onApply?: (result: ApplyResult) => void;
}

type Params = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowOnly(params: Params, allowed: string[]) {
  const unknown = Object.keys(params).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new RpcError(
      ERRORS.InvalidParams,
      `unknown parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
    );
  }
}

function optionalString(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new RpcError(ERRORS.InvalidParams, `${key} must be a string`);
  return value;
}

function rejectRef(params: Params) {
  if (params.ref !== undefined) {
    throw new RpcError(ERRORS.Unsupported, "this server edits a working tree: it has no branches");
  }
}

export function createLocalContentHandler(storage: ContentStorage, options: HandlerOptions) {
  const limits = options.limits ?? DEFAULT_LIMITS;

  const methods: Record<string, (params: Params) => unknown> = {
    describe(params) {
      allowOnly(params, []);
      return {
        protocol: "deco-content",
        version: { major: 1, minor: 0 },
        server: { name: "deco-cli", version: options.serverVersion },
        kind: storage.kind,
        readOnly: options.readOnly,
        root: options.root,
        schemaFormat: SCHEMA_FORMAT,
        refs: null,
        writes: { idempotency: null, schemaPreconditions: false },
        pollIntervalMs: POLL_INTERVAL_MS,
        limits,
        preview: options.previewOrigin ? { origin: options.previewOrigin } : null,
        assets:
          options.readOnly || !options.assets
            ? null
            : { dir: options.assets.dir, urlPrefix: "/assets/", maxBytes: options.assets.maxBytes },
        secrets: (() => {
          const publicKey = options.secretsPublicKey();
          return publicKey ? { publicKey } : null;
        })(),
      };
    },

    "schema.get"(params) {
      allowOnly(params, ["ref", "ifNoneMatch"]);
      rejectRef(params);
      const ifNoneMatch = optionalString(params, "ifNoneMatch");
      if (!storage.exists())
        throw new RpcError(ERRORS.NotFound, "no .deco folder: not a Deco site");
      let schema: ReturnType<ContentStorage["readSchema"]>;
      try {
        schema = storage.readSchema();
      } catch {
        throw new RpcError(
          ERRORS.Unavailable,
          "the schema file isn't valid JSON (mid-write?); retry",
          {
            retryAfterMs: 500,
          },
        );
      }
      if (!schema) throw new RpcError(ERRORS.NotFound, "no .deco/schema.gen.json: run deco schema");
      if (schema.bytes > limits.maxSchemaBytes) {
        throw new RpcError(
          ERRORS.LimitExceeded,
          `the schema is over ${limits.maxSchemaBytes} bytes`,
        );
      }
      if (ifNoneMatch === schema.version) return { notModified: true, version: schema.version };
      return {
        notModified: false,
        version: schema.version,
        resolvedRef: null,
        schema: schema.schema,
      };
    },

    "blocks.list"(params) {
      allowOnly(params, ["ref", "ifNoneMatch"]);
      rejectRef(params);
      const ifNoneMatch = optionalString(params, "ifNoneMatch");
      if (!storage.exists())
        throw new RpcError(ERRORS.NotFound, "no .deco folder: not a Deco site");
      const snapshot = storage.readBlocks();
      if (ifNoneMatch === snapshot.revision) {
        return { notModified: true, revision: snapshot.revision, resolvedRef: null };
      }
      const bytes = Buffer.byteLength(JSON.stringify(snapshot.blocks));
      if (bytes > limits.maxListBytes) {
        throw new RpcError(
          ERRORS.LimitExceeded,
          `the saved blocks are over ${limits.maxListBytes} bytes`,
        );
      }
      return {
        notModified: false,
        revision: snapshot.revision,
        resolvedRef: null,
        blocks: snapshot.blocks,
        versions: snapshot.versions,
        diagnostics: snapshot.diagnostics.map((d) => ({ file: d.file, message: d.message })),
      };
    },

    "blocks.apply"(params) {
      allowOnly(params, ["ref", "requestKey", "ifSchemaMatch", "set", "delete", "ifMatch"]);
      rejectRef(params);
      if (params.requestKey !== undefined) {
        throw new RpcError(
          ERRORS.Unsupported,
          "requestKey isn't supported: describe.writes.idempotency is null",
        );
      }
      if (params.ifSchemaMatch !== undefined) {
        throw new RpcError(
          ERRORS.Unsupported,
          "ifSchemaMatch isn't supported: describe.writes.schemaPreconditions is false",
        );
      }
      if (options.readOnly) throw new RpcError(ERRORS.ReadOnly, "this server is read-only");
      if (!storage.exists())
        throw new RpcError(ERRORS.NotFound, "no .deco folder: not a Deco site");

      const set = params.set ?? {};
      const del = params.delete ?? [];
      const ifMatch = params.ifMatch ?? {};
      if (!isObject(set))
        throw new RpcError(ERRORS.InvalidParams, "set must be an object of entries by name");
      if (!Array.isArray(del) || !del.every((n) => typeof n === "string")) {
        throw new RpcError(ERRORS.InvalidParams, "delete must be a list of names");
      }
      if (
        !isObject(ifMatch) ||
        !Object.values(ifMatch).every((v) => v === null || typeof v === "string")
      ) {
        throw new RpcError(ERRORS.InvalidParams, "ifMatch must map names to a version or null");
      }
      const ops = Object.keys(set).length + del.length;
      if (ops > limits.maxOpsPerApply) {
        throw new RpcError(ERRORS.LimitExceeded, `${ops} operations, max ${limits.maxOpsPerApply}`);
      }

      const snapshot = storage.readBlocks();
      const existing = Object.keys(snapshot.versions);
      const violations: { name: string; path?: string; message: string }[] = [];
      for (const [name, entry] of Object.entries(set)) {
        const reason = invalidNameReason(name, existing);
        if (reason) violations.push({ name, message: reason });
        if (!isObject(entry)) {
          violations.push({ name, message: "an entry must be a JSON object" });
          continue;
        }
        if (typeof entry.__resolveType !== "string") {
          violations.push({ name, message: "an entry must have a string __resolveType" });
        }
        const bytes = Buffer.byteLength(serializeEntry(entry));
        if (bytes > limits.maxBlockBytes) {
          violations.push({ name, message: `${bytes} bytes, max ${limits.maxBlockBytes}` });
        }
      }
      for (const name of del as string[]) {
        if (name.length === 0 || name.includes("\0") || name === "__proto__") {
          violations.push({ name, message: "invalid name" });
        }
      }
      // The secret guard: a Secret field holds only a well-formed secret block.
      if (Object.keys(set).length > 0) {
        let meta: DecoMeta | null = null;
        try {
          meta = (storage.readSchema()?.schema as DecoMeta) ?? null;
        } catch {
          meta = null;
        }
        if (meta?.schema?.definitions) {
          const blocks = {
            ...snapshot.blocks,
            ...(set as Record<string, Record<string, unknown>>),
          };
          for (const p of secretViolations(meta, blocks, Object.keys(set))) {
            violations.push({ name: p.file, path: p.path, message: p.message });
          }
        }
      }
      if (violations.length > 0) {
        throw new RpcError(
          ERRORS.InvalidBlock,
          `${violations.length} invalid operation${violations.length > 1 ? "s" : ""}`,
          {
            violations,
          },
        );
      }

      const conflicts: { name: string; expected: string | null; actual: string | null }[] = [];
      for (const [name, expected] of Object.entries(ifMatch as Record<string, string | null>)) {
        const actual = snapshot.versions[name] ?? null;
        if (actual !== expected) conflicts.push({ name, expected, actual });
      }
      if (conflicts.length > 0) {
        throw new RpcError(ERRORS.Conflict, "an entry isn't at the expected version", {
          conflicts,
        });
      }

      let result: ApplyResult;
      try {
        result = storage.apply({
          set: set as Record<string, Record<string, unknown>>,
          delete: del as string[],
        });
      } catch (error) {
        throw new RpcError(ERRORS.Unavailable, `the write failed: ${(error as Error).message}`);
      }
      options.onApply?.(result);
      return { revision: result.revision, versions: result.versions };
    },
  };

  function call(request: unknown): Record<string, unknown> {
    const id =
      isObject(request) && (typeof request.id === "string" || typeof request.id === "number")
        ? request.id
        : null;
    try {
      if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
        throw new RpcError(ERRORS.InvalidRequest, "not a JSON-RPC 2.0 request");
      }
      if (id === null) {
        throw new RpcError(
          ERRORS.InvalidRequest,
          "every request needs an id: a dropped write is worse than an error",
        );
      }
      const params = request.params ?? {};
      if (!isObject(params)) throw new RpcError(ERRORS.InvalidParams, "params must be an object");
      const method = methods[request.method];
      if (!method || !Object.hasOwn(methods, request.method)) {
        throw new RpcError(ERRORS.MethodNotFound, `no method "${request.method}"`);
      }
      return { jsonrpc: "2.0", id, result: method(params) };
    } catch (error) {
      const e =
        error instanceof RpcError
          ? error
          : new RpcError(ERRORS.InternalError, (error as Error).message ?? "internal error");
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: e.code,
          message: e.message,
          ...(e.data !== undefined ? { data: e.data } : {}),
        },
      };
    }
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** One HTTP request: a single call or a batch of up to ten. */
  return async function handle(request: Request): Promise<Response> {
    const text = await request.text();
    if (Buffer.byteLength(text) > limits.maxRequestBytes) {
      return json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: ERRORS.LimitExceeded, message: "request too large" },
        },
        413,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({
        jsonrpc: "2.0",
        id: null,
        error: { code: ERRORS.ParseError, message: "invalid JSON" },
      });
    }
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return json({
          jsonrpc: "2.0",
          id: null,
          error: { code: ERRORS.InvalidRequest, message: "empty batch" },
        });
      }
      if (body.length > MAX_BATCH) {
        return json({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: ERRORS.LimitExceeded,
            message: `${body.length} calls in one batch, max ${MAX_BATCH}`,
          },
        });
      }
      return json(body.map(call));
    }
    return json(call(body));
  };
}
