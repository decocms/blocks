/**
 * A small content-protocol client: one method per protocol method, plus
 * batches. Uses `fetch`, so it runs in browsers, on Workers and on Node.
 */
import {
  ContentProtocolError,
  ErrorCode,
  type RpcErrorObject,
  type UnsupportedEndpointData,
} from "./errors.ts";
import {
  type DescribeResult,
  type MethodName,
  type Methods,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  REQUIRED_PROTOCOL_MINOR,
  type RpcId,
} from "./types.ts";

export interface ContentClientOptions {
  /** The endpoint URL, such as `http://localhost:4545/rpc`. */
  endpoint: string | URL;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** A fetch implementation (defaults to the global one). */
  fetch?: (input: Request) => Promise<Response>;
}

/** One call of a batch. */
export type BatchCall = {
  [M in MethodName]: { method: M; params?: Methods[M]["params"] };
}[MethodName];

/** The outcome of one batch call: its result or its error. */
export type BatchOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: ContentProtocolError };

export interface ContentClient {
  /**
   * Throws Unsupported when the endpoint speaks another protocol or major
   * version, or an older minor than this client needs (`data.reason`, see
   * `UnsupportedEndpointData`).
   */
  describe(): Promise<Methods["describe"]["result"]>;
  schemaGet(params?: Methods["schema.get"]["params"]): Promise<Methods["schema.get"]["result"]>;
  blocksList(params?: Methods["blocks.list"]["params"]): Promise<Methods["blocks.list"]["result"]>;
  blocksApply(
    params: Methods["blocks.apply"]["params"],
  ): Promise<Methods["blocks.apply"]["result"]>;
  changesList(
    params?: Methods["changes.list"]["params"],
  ): Promise<Methods["changes.list"]["result"]>;
  changesGet(params: Methods["changes.get"]["params"]): Promise<Methods["changes.get"]["result"]>;
  changesDiscard(
    params: Methods["changes.discard"]["params"],
  ): Promise<Methods["changes.discard"]["result"]>;
  /**
   * Calls one method by name. Throws `ContentProtocolError` on an error
   * response; a server too old for a `changes.*` method (MethodNotFound)
   * becomes the same Unsupported `describe` raises (`reason: "outdated"`).
   */
  call<M extends MethodName>(
    method: M,
    params?: Methods[M]["params"],
  ): Promise<Methods[M]["result"]>;
  /** Runs several calls in one request; outcomes come back in order. */
  batch(calls: BatchCall[]): Promise<BatchOutcome[]>;
}

type WireResponse = { id: RpcId | null; result?: unknown; error?: RpcErrorObject };

/**
 * Decodes a JSON response body, gunzipping it when a custom fetch (such as an
 * in-process handler) handed back the raw gzip bytes.
 */
export async function readResponseJson(response: Response): Promise<unknown> {
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(
        new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      );
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

const REQUIRED_VERSION = { major: PROTOCOL_VERSION.major, minor: REQUIRED_PROTOCOL_MINOR };

/** The guidance for a server older than this client: update it. */
const OUTDATED_MESSAGE =
  `the endpoint speaks an older ${PROTOCOL_NAME} than this client needs ` +
  `(${REQUIRED_VERSION.major}.${REQUIRED_VERSION.minor} or newer): update @decocms/blocks in the site ` +
  "(8.2.0 or newer) and start deco serve again";

function unsupportedEndpoint(
  message: string,
  reason: UnsupportedEndpointData["reason"],
  description?: Partial<DescribeResult>,
): ContentProtocolError {
  const data: UnsupportedEndpointData = { reason, required: { ...REQUIRED_VERSION } };
  if (description) {
    data.actual = {
      protocol: description.protocol,
      major: description.version?.major,
      minor: description.version?.minor,
    };
    const server = description.server;
    if (typeof server?.name === "string" && typeof server.version === "string") {
      data.server = { name: server.name, version: server.version };
    }
  }
  return new ContentProtocolError(ErrorCode.Unsupported, message, data);
}

/**
 * Refuses an endpoint this client can't speak to: another protocol, another
 * major version, or a minor older than `REQUIRED_PROTOCOL_MINOR` (minors only
 * add, so any newer minor is fine). The error's `data` is an
 * `UnsupportedEndpointData`; `reason: "outdated"` means "update the server".
 */
export function assertSupportedEndpoint(description: DescribeResult): DescribeResult {
  const reported = (description ?? {}) as Partial<DescribeResult>;
  const { protocol, version } = reported;
  if (protocol !== PROTOCOL_NAME) {
    throw unsupportedEndpoint(
      `the endpoint speaks ${JSON.stringify(protocol)}, not ${PROTOCOL_NAME}`,
      "protocol",
      reported,
    );
  }
  if (version?.major !== PROTOCOL_VERSION.major) {
    throw unsupportedEndpoint(
      `the endpoint speaks ${PROTOCOL_NAME} ${String(version?.major)}.x; this client speaks ${PROTOCOL_VERSION.major}.x`,
      "major",
      reported,
    );
  }
  if (typeof version.minor !== "number" || version.minor < REQUIRED_PROTOCOL_MINOR) {
    throw unsupportedEndpoint(OUTDATED_MESSAGE, "outdated", reported);
  }
  return description;
}

/** A server that doesn't know a `changes.*` method is older than this client. */
function fromWireError(method: string, error: RpcErrorObject): ContentProtocolError {
  if (error.code === ErrorCode.MethodNotFound && method.startsWith("changes.")) {
    return unsupportedEndpoint(OUTDATED_MESSAGE, "outdated");
  }
  return ContentProtocolError.from(error);
}

export function createContentClient(options: ContentClientOptions): ContentClient {
  const doFetch = options.fetch ?? ((request: Request) => fetch(request));
  let nextId = 1;

  async function post(body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...options.headers,
    };
    const response = await doFetch(
      new Request(options.endpoint, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    let payload: unknown;
    try {
      payload = await readResponseJson(response);
    } catch {
      throw new ContentProtocolError(
        ErrorCode.Unavailable,
        `the endpoint answered HTTP ${response.status} without a JSON-RPC body`,
      );
    }
    if (!response.ok || (!Array.isArray(payload) && (payload as WireResponse)?.id === null)) {
      const error = (payload as WireResponse)?.error;
      if (error) throw ContentProtocolError.from(error);
      throw new ContentProtocolError(
        ErrorCode.Unavailable,
        `the endpoint answered HTTP ${response.status}`,
      );
    }
    return payload;
  }

  const call = async <M extends MethodName>(method: M, params?: Methods[M]["params"]) => {
    const id = nextId++;
    const response = (await post({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    })) as WireResponse;
    if (response.error) throw fromWireError(method, response.error);
    return response.result as Methods[M]["result"];
  };

  return {
    call,
    describe: async () => assertSupportedEndpoint(await call("describe")),
    schemaGet: (params) => call("schema.get", params),
    blocksList: (params) => call("blocks.list", params),
    blocksApply: (params) => call("blocks.apply", params),
    changesList: (params) => call("changes.list", params),
    changesGet: (params) => call("changes.get", params),
    changesDiscard: (params) => call("changes.discard", params),
    async batch(calls) {
      const ids = calls.map(() => nextId++);
      const responses = (await post(
        calls.map((c, i) => ({
          jsonrpc: "2.0",
          id: ids[i],
          method: c.method,
          params: c.params ?? {},
        })),
      )) as WireResponse[];
      const byId = new Map(responses.map((r) => [r.id, r]));
      return ids.map((id, i): BatchOutcome => {
        const response = byId.get(id);
        if (!response) {
          return {
            ok: false,
            error: new ContentProtocolError(ErrorCode.InternalError, "no response for this call"),
          };
        }
        return response.error
          ? { ok: false, error: fromWireError(calls[i]!.method, response.error) }
          : { ok: true, result: response.result };
      });
    },
  };
}
