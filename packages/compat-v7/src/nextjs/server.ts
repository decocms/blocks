/**
 * `@decocms/compat-v7/nextjs/server`: v7's matchers and device in a Next.js
 * App Router site's server components. Server only: it reads `next/headers`.
 *
 * - `requestDevice()`: the request's device, v7's `detectDevice` on its user
 *   agent, for `DeviceProvider` (`@decocms/compat-v7/nextjs`).
 * - `matcherContext()`: the request a matcher from
 *   `@decocms/compat-v7/matchers` reads, at the URL the site's proxy
 *   forwarded (`@decocms/compat-v7/nextjs/proxy`), one per page URL within a
 *   request (React's per-request `cache`).
 *
 * ```tsx
 * // the block map
 * "website/matchers/device.ts": async (props: DeviceProps) => device(props, await matcherContext()),
 * ```
 */
import { headers } from "next/headers.js";
import { cache } from "react";
import { type Device, detectDevice } from "../device.ts";
import type { MatcherContext } from "../matchers/context.ts";
import { PAGE_URL_HEADER } from "./shared.ts";

export type { Device } from "../device.ts";
export type { MatcherContext } from "../matchers/index.ts";
export { PAGE_URL_HEADER };

interface RequestState {
  request?: Request;
  contexts: Map<string, MatcherContext>;
}

/** One state per request: React's `cache` is scoped to the server render of a request. */
const requestState = cache((): RequestState => ({ contexts: new Map() }));

/** The request's device: v7's `detectDevice` on its user agent. */
export async function requestDevice(): Promise<Device> {
  return detectDevice((await headers()).get("user-agent") ?? "");
}

/**
 * The matchers' input for the request being rendered: a `Request` with its
 * headers at the page's URL. The URL is `pageUrl`, else the one the site's
 * proxy forwarded on `x-deco-page-url`. The same
 * object for the same URL within a request, so each matcher reads one
 * context, as in v7.
 */
export async function matcherContext(pageUrl?: string | URL): Promise<MatcherContext> {
  const incoming = await headers();
  const state = requestState();
  const forwarded = pageUrl ?? incoming.get(PAGE_URL_HEADER);
  if (!forwarded) {
    throw new TypeError(
      "@decocms/compat-v7/nextjs: the matchers need the page's URL. Forward it from the site's " +
        "proxy (pageUrlRequestHeaders from @decocms/compat-v7/nextjs/proxy), or pass it: " +
        "matcherContext(url).",
    );
  }
  const url = new URL(String(forwarded)).href;
  let context = state.contexts.get(url);
  if (!context) {
    state.request ??= new Request(url, { headers: new Headers(incoming) });
    context = { request: state.request, url };
    state.contexts.set(url, context);
  }
  return context;
}
