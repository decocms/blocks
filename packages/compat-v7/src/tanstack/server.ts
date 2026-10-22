/**
 * `@decocms/compat-v7/tanstack/server`: what v7's TanStack page route did
 * around the matchers and the device, for a site on `@decocms/tanstack`.
 * Server only: never import it from a component that ships to the browser.
 *
 * - `requestDevice()`: the request's device, v7's `detectDevice` on its user
 *   agent (the class `detectDevice` from `@decocms/tanstack/worker` gives a
 *   site's cache key), for the page to pass to `DeviceProvider`.
 * - `matcherContext(pageUrl?)`: the request a matcher from
 *   `@decocms/compat-v7/matchers` reads, with one `flags` array per request,
 *   so the sticky random matcher reuses a decision and records new ones.
 * - `commitSegmentCookie()`: after the page resolved, the `deco_segment`
 *   cookie with the visitor's A/B groups, as v7's `persistFlags` set it (latest
 *   7.x). Call it in the page's server function, where TanStack Start still
 *   takes response headers. A site's page cache never stores a response that
 *   sets it (keep it out of the cookies the cache strips and stores).
 * - `cohortSegment(request)`: v7's A/B split of the edge cache (its `__abf`
 *   key part), for the segment of the site's own page cache (the worker-entry
 *   recipe in `@decocms/tanstack`'s README), so each group keeps its own
 *   cached page.
 *
 * ```ts
 * // src/blocks.ts (the block map)
 * "website/matchers/random.ts": (props: RandomProps) => random(props, matcherContext()),
 *
 * // the page's server function
 * const page = await openPage(data.href);         // resolves the matchers
 * commitSegmentCookie();
 *
 * // src/worker-entry.ts: the site's cache segment
 * const segment = (request: Request) => ({ device: …, ...cohortSegment(request) });
 * ```
 */
import { isServerFnCall } from "@decocms/tanstack/server";
import { getRequest, getResponseHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { type Device, detectDevice } from "../device.ts";
import type { MatcherContext } from "../matchers/context.ts";
import {
  parseSegmentCookie,
  SEGMENT_COOKIE,
  type StoredFlag,
  segmentCacheToken,
  segmentSetCookie,
} from "../matchers/segment.ts";

export type { Device } from "../device.ts";
export type { MatcherContext, StoredFlag } from "../matchers/index.ts";

interface RequestState {
  flags: StoredFlag[];
  contexts: Map<string, MatcherContext>;
}

const states = new WeakMap<Request, RequestState>();

function stateOf(request: Request): RequestState {
  let state = states.get(request);
  if (!state) {
    state = { flags: [], contexts: new Map() };
    states.set(request, state);
  }
  return state;
}

/**
 * The device of `request` (default: the request being served): v7's
 * `detectDevice` on its user agent.
 */
export function requestDevice(request: Request = getRequest()): Device {
  return detectDevice(request.headers.get("user-agent") ?? "");
}

/**
 * The matchers' input for the request being served: the request, the page's
 * URL and the request's `flags`. The same object for the same request and
 * URL, so each matcher reads one context, as in v7.
 *
 * On a client-side navigation the request is the server-function call, not
 * the page: pass the page's URL (`pageUrl`), as v7 matched the page being
 * navigated to. Without it, such a call throws, instead of matching
 * `/_serverFn/…`.
 */
export function matcherContext(
  pageUrl?: string | URL,
  request: Request = getRequest(),
): MatcherContext {
  if (pageUrl === undefined && isServerFnCall(request)) {
    throw new TypeError(
      "@decocms/compat-v7/tanstack: on a client-side navigation the request is a server-function " +
        "call; pass the page's URL: matcherContext(new URL(href, request.url)).",
    );
  }
  const url = new URL(String(pageUrl ?? request.url), request.url).href;
  const state = stateOf(request);
  let context = state.contexts.get(url);
  if (!context) {
    context = { request, url, flags: state.flags };
    state.contexts.set(url, context);
  }
  return context;
}

/**
 * Sets the `deco_segment` cookie keeping the A/B decisions the matchers made
 * on `request` (default: the request being served), merged over the
 * visitor's cookie, byte for byte as v7 did:
 * `deco_segment=<value>; Max-Age=31536000; Path=/; SameSite=Lax`. Sets
 * nothing when the cookie already says the same. Returns the `Set-Cookie`
 * value it set, or `null`. Calling it again replaces the earlier one.
 */
export function commitSegmentCookie(request: Request = getRequest()): string | null {
  const value = segmentSetCookie(request, stateOf(request).flags);
  if (value === null) return null;
  // `getResponseHeaders()` and `setResponseHeader(name, list)` exist in every
  // TanStack Start the binding supports (`getResponse()` went away in 1.169).
  const others = getResponseHeaders()
    .getSetCookie()
    .filter((c) => !c.startsWith(`${SEGMENT_COOKIE}=`));
  setResponseHeader("set-cookie", [...others, value]);
  return value;
}

/**
 * v7's A/B split of the edge cache: `{ abf: <token> }` for a visitor with
 * groups in `deco_segment` (`name:1|0:pct`, sorted), `{}` for one without, so
 * visitors outside every test keep sharing one entry. Spread it into the
 * segment of the site's own page cache (the worker-entry recipe).
 */
export function cohortSegment(request: Request): { abf?: string } {
  const token = segmentCacheToken(parseSegmentCookie(readRequestCookie(request, SEGMENT_COOKIE)));
  return token ? { abf: token } : {};
}

/**
 * The cookie as v7's worker read it for the cache key (`@decocms/tanstack@7`
 * sdk/workerEntry.ts' `readRequestCookie`): the first pair with the name,
 * trimmed, URL-decoded once when it can be.
 */
function readRequestCookie(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    if (pair.slice(0, idx).trim() !== name) continue;
    const raw = pair.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
