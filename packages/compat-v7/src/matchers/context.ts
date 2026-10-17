/**
 * What a v7 matcher saw, rebuilt from the request. v7's TanStack page route
 * handed every matcher a context made from the request being served
 * (`@decocms/tanstack@7` routes/cmsRoute.ts): the user agent, the page's URL
 * and path, and the cookies as h3 parsed them. A v8 block function gets only
 * its inputs, so the site passes the request in, and this module makes the
 * same context from it.
 */
import type { StoredFlag } from "./segment.ts";

/** The request a matcher reads, and the page it renders. */
export interface MatcherContext {
  /** The request being served. */
  request: Request;
  /**
   * The page's URL, when it isn't `request.url`: on a client-side navigation
   * the request is the framework's server-function call, and v7 matched the
   * page being navigated to. Defaults to `request.url`.
   */
  url?: string | URL;
  /**
   * The request's sticky A/B decisions. Pass one array per request to every
   * matcher: `random` reuses a decision already in it and records each new
   * one, and `segmentSetCookie` turns it into the `deco_segment` cookie.
   * Without it, `random` still honours the visitor's cookie but records
   * nothing (v7 did the same with no `flags`).
   */
  flags?: StoredFlag[];
}

/** A request, or a request with the page's URL and the request's flags. */
export type MatcherInput = Request | MatcherContext;

/** v7's `MatcherContext` (`@decocms/blocks@7` cms/resolve.ts), as its TanStack route filled it. */
export interface V7MatcherContext {
  userAgent: string;
  url: string;
  path: string;
  cookies: Record<string, string>;
  request: Request;
  flags?: StoredFlag[];
}

const contexts = new WeakMap<object, V7MatcherContext>();

/** The v7 context for `input`, made once per request (or context object). */
export function v7Context(input: MatcherInput): V7MatcherContext {
  if (input === null || typeof input !== "object") {
    throw new TypeError(
      "@decocms/compat-v7/matchers: a matcher takes the request as its second argument, " +
        "e.g. `(props) => device(props, request)`. v8 passes a block function only its inputs, " +
        "so the site's block map hands the request in.",
    );
  }
  const known = contexts.get(input);
  if (known) return known;
  const request = input instanceof Request ? input : input.request;
  if (!(request instanceof Request)) {
    throw new TypeError(
      "@decocms/compat-v7/matchers: pass the Request, or { request, url?, flags? }.",
    );
  }
  const url = String((input instanceof Request ? undefined : input.url) ?? request.url);
  const ctx: V7MatcherContext = {
    userAgent: request.headers.get("user-agent") ?? "",
    url,
    path: pagePath(url),
    cookies: parseCookies(request.headers.get("cookie") ?? ""),
    request,
    flags: input instanceof Request ? undefined : input.flags,
  };
  contexts.set(input, ctx);
  return ctx;
}

/**
 * The page's path as v7 matched it: TanStack Router's splat parameter, which
 * it decodes with `decodeURIComponent` (an undecodable path stays as sent).
 */
function pagePath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * The `Cookie` header as v7 read it (`getCookies()` from TanStack Start, which
 * is h3 2's `parse`): the first value of a name wins, values are trimmed, one
 * pair of surrounding double quotes is dropped, and a value with `%` is
 * URL-decoded when it can be.
 */
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  let index = 0;
  while (index < header.length) {
    const eq = header.indexOf("=", index);
    if (eq === -1) break;
    let end = header.indexOf(";", index);
    if (end === -1) end = header.length;
    else if (end < eq) {
      index = header.lastIndexOf(";", eq - 1) + 1;
      continue;
    }
    const key = header.slice(index, eq).trim();
    if (out[key] === undefined) {
      let value = header.slice(eq + 1, end).trim();
      if (value.codePointAt(0) === 34) value = value.slice(1, -1);
      try {
        out[key] = value.includes("%") ? decodeURIComponent(value) : value;
      } catch {
        out[key] = value;
      }
    }
    index = end + 1;
  }
  return out;
}
