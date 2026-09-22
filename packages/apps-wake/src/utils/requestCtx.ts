import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { parseHeaders } from "./parseHeaders";

/**
 * Request-scoped helpers bridging the Deno `(req, ctx)` convention to this
 * architecture's `RequestContext` singleton. Loaders/actions read the active
 * request's URL/cookies and write Set-Cookie via these.
 */

export const currentRequest = (): Request | null => RequestContext.current?.request ?? null;

export const currentUrl = (): URL => new URL(currentRequest()?.url ?? "https://localhost");

export const currentRequestHeaders = (): Headers => currentRequest()?.headers ?? new Headers();

export const currentResponseHeaders = (): Headers =>
  RequestContext.current?.responseHeaders ?? new Headers();

/** Client-IP forwarding headers for the storefront GraphQL call. */
export const forwardedHeaders = (): Record<string, string> => {
  const req = currentRequest();
  return req ? parseHeaders(req.headers) : {};
};

/**
 * Whether the active request is HTTPS — drives the `Secure` cookie flag.
 * A `Secure` cookie is rejected by browsers over plain HTTP (e.g. localhost
 * dev), so cookies must only be marked Secure on real HTTPS requests. Defaults
 * to `true` when the request is unknown (prod-safety).
 */
export const isSecureRequest = (): boolean => {
  const req = currentRequest();
  if (!req) return true;
  try {
    const proto = req.headers.get("x-forwarded-proto");
    if (proto) return proto.split(",")[0].trim() === "https";
    return new URL(req.url).protocol === "https:";
  } catch {
    return true;
  }
};
