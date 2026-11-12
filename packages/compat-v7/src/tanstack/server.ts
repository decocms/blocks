/**
 * `@decocms/compat-v7/tanstack/server`: what v7's TanStack page route did
 * around the matchers and the device, for a site on `@decocms/tanstack`.
 * Server only: never import it from a component that ships to the browser.
 *
 * - `requestDevice()`: the request's device, v7's `detectDevice` on its user
 *   agent (the class `detectDevice` from `@decocms/tanstack/worker` gives a
 *   site's cache key), for the page to pass to `DeviceProvider`.
 * - `matcherContext(pageUrl?)`: the request a matcher from
 *   `@decocms/compat-v7/matchers` reads, at the page's URL.
 *
 * ```ts
 * // src/blocks.ts (the block map)
 * "website/matchers/device.ts": (props: DeviceProps) => device(props, matcherContext()),
 * ```
 */
import { isServerFnCall } from "@decocms/tanstack/server";
import { getRequest } from "@tanstack/react-start/server";
import { type Device, detectDevice } from "../device.ts";
import type { MatcherContext } from "../matchers/context.ts";

export type { Device } from "../device.ts";
export type { MatcherContext } from "../matchers/index.ts";

/** The matchers' contexts of each request, by page URL. */
const contexts = new WeakMap<Request, Map<string, MatcherContext>>();

/**
 * The device of `request` (default: the request being served): v7's
 * `detectDevice` on its user agent.
 */
export function requestDevice(request: Request = getRequest()): Device {
  return detectDevice(request.headers.get("user-agent") ?? "");
}

/**
 * The matchers' input for the request being served: the request and the
 * page's URL. The same object for the same request and URL, so each matcher
 * reads one context, as in v7.
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
  let byUrl = contexts.get(request);
  if (!byUrl) {
    byUrl = new Map();
    contexts.set(request, byUrl);
  }
  let context = byUrl.get(url);
  if (!context) {
    context = { request, url };
    byUrl.set(url, context);
  }
  return context;
}
