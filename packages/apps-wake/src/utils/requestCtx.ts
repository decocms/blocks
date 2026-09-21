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
