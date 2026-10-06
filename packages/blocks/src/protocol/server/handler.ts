/**
 * `createContentHandler(storage)`: the content protocol as a fetch handler,
 * `(Request) => Promise<Response>`.
 *
 * `POST <endpoint>` with `Content-Type: application/json` and a body that's
 * one request object or a batch array. Errors come back in the JSON-RPC
 * `error` object with HTTP 200, except a body over the size limit (413),
 * which applies to the whole batch, and requests that aren't the protocol at all: a method other than POST (405),
 * or a body that isn't JSON or uses an unsupported encoding (415). Those carry
 * a JSON-RPC error body too, with a `null` id.
 * Responses are gzip-compressed when the request accepts it.
 *
 * The handler is path-agnostic: mount it where the endpoint lives (`/rpc` on
 * the local server). The handler doesn't authenticate: who may call it, and
 * transport security that depends on where it runs — CORS, `Host` checks,
 * Chrome's local-network preflight — belong to the server that mounts it
 * (`deco serve` on loopback; Studio behind its own session).
 */
import { type ContentProtocolError, invalidRequest, limitExceeded, parseError } from "../errors.ts";
import type { ContentStorage } from "../storage.ts";
import { type ContentHandlerOptions, Core, MAX_REQUEST_BYTES } from "./core.ts";
import {
  BodyEncodingError,
  BodyTooLargeError,
  isJsonContentType,
  jsonResponse,
  readBody,
} from "./http.ts";
import { dispatch } from "./rpc.ts";

export type ContentHandler = (request: Request) => Promise<Response>;

const errorBody = (error: ContentProtocolError) =>
  JSON.stringify({ jsonrpc: "2.0", id: null, error: error.toJSON() });

export function createContentHandler(
  storage: ContentStorage,
  options: ContentHandlerOptions = {},
): ContentHandler {
  const core = new Core(storage, options);

  return async (request) => {
    if (request.method !== "POST") {
      return jsonResponse(request, errorBody(invalidRequest("use POST")), 405, { allow: "POST" });
    }
    if (!isJsonContentType(request)) {
      return jsonResponse(
        request,
        errorBody(invalidRequest("Content-Type must be application/json")),
        415,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBody(request, MAX_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return jsonResponse(
          request,
          errorBody(
            limitExceeded(`the request body is over ${MAX_REQUEST_BYTES} bytes`, {
              limit: "maxRequestBytes",
            }),
          ),
          413,
        );
      }
      if (error instanceof BodyEncodingError) {
        return jsonResponse(request, errorBody(invalidRequest(error.message)), 415);
      }
      throw error;
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return jsonResponse(request, errorBody(parseError()));
    }
    return jsonResponse(request, await dispatch(core, body));
  };
}
