/**
 * The JSON-RPC 2.0 layer: envelope validation, batches and dispatch.
 *
 * - Every request has an `id`; one without is rejected rather than run.
 * - A batch runs in order, returns results in order, holds at most 10 calls,
 *   and isn't atomic.
 */
import {
  type ContentProtocolError,
  internalError,
  invalidRequest,
  limitExceeded,
  methodNotFound,
} from "../errors.ts";
import { validateParams } from "../params.ts";
import { MAX_BATCH_CALLS, METHOD_NAMES, type MethodName, type RpcId } from "../types.ts";
import { type Core, toProtocolError } from "./core.ts";
import { blocksApply } from "./methods/apply.ts";
import { blocksList, describe, schemaGet } from "./methods/read.ts";

type Envelope = { id: RpcId; method: MethodName; params: unknown };

const isMethod = (method: string): method is MethodName =>
  (METHOD_NAMES as readonly string[]).includes(method);

/** Validates one request object; returns the error response's id on failure. */
function parseEnvelope(
  value: unknown,
): Envelope | { error: ContentProtocolError; id: RpcId | null } {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const raw = (isObject ? value : {}) as Record<string, unknown>;
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null;
  if (!isObject) return { error: invalidRequest("a request must be an object"), id: null };
  if (raw.jsonrpc !== "2.0") return { error: invalidRequest('jsonrpc must be "2.0"'), id };
  if (id === null) {
    return { error: invalidRequest("every request needs a string or number id"), id: null };
  }
  if (typeof raw.method !== "string")
    return { error: invalidRequest("method must be a string"), id };
  for (const key of Object.keys(raw)) {
    if (!["jsonrpc", "id", "method", "params"].includes(key)) {
      return { error: invalidRequest(`unknown request member "${key}"`), id };
    }
  }
  if (!isMethod(raw.method)) return { error: methodNotFound(raw.method), id };
  return { id, method: raw.method, params: raw.params };
}

async function run(core: Core, envelope: Envelope): Promise<unknown> {
  switch (envelope.method) {
    case "describe":
      validateParams("describe", envelope.params);
      return describe(core);
    case "schema.get":
      return schemaGet(core, validateParams("schema.get", envelope.params));
    case "blocks.list":
      return blocksList(core, validateParams("blocks.list", envelope.params));
    case "blocks.apply":
      return blocksApply(core, validateParams("blocks.apply", envelope.params));
  }
}

const errorResponse = (id: RpcId | null, error: ContentProtocolError) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: error.toJSON() });

async function call(core: Core, value: unknown): Promise<string> {
  const envelope = parseEnvelope(value);
  if ("error" in envelope) return errorResponse(envelope.id, envelope.error);
  try {
    const result = await run(core, envelope);
    return JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result });
  } catch (error) {
    const known = toProtocolError(error);
    if (known) return errorResponse(envelope.id, known);
    core.options.onError?.(error);
    return errorResponse(envelope.id, internalError());
  }
}

/**
 * Runs a parsed request body (one request object or a batch array) and
 * returns the serialized response body.
 */
export async function dispatch(core: Core, body: unknown): Promise<string> {
  if (!Array.isArray(body)) return call(core, body);
  if (body.length === 0) return errorResponse(null, invalidRequest("an empty batch"));
  if (body.length > MAX_BATCH_CALLS) {
    return errorResponse(
      null,
      limitExceeded(`a batch holds at most ${MAX_BATCH_CALLS} calls`, { limit: "maxBatchCalls" }),
    );
  }
  const responses: string[] = [];
  for (const item of body) responses.push(await call(core, item));
  return `[${responses.join(",")}]`;
}
