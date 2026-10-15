/**
 * `@decocms/compat-v7/nextjs/server`: v7's matchers and device in a Next.js
 * App Router site's server components. Server only: it reads `next/headers`.
 *
 * - `requestDevice()`: the request's device, v7's `detectDevice` on its user
 *   agent, for `DeviceProvider` (`@decocms/compat-v7/nextjs`).
 * - `matcherContext()`: the request a matcher from
 *   `@decocms/compat-v7/matchers` reads, at the URL the site's proxy
 *   forwarded (`@decocms/compat-v7/nextjs/proxy`), with one `flags` array per
 *   request (React's per-request `cache`), so the sticky random matcher
 *   (latest 7.x) reuses a decision and records new ones.
 * - `SegmentCookie`: writes the `deco_segment` cookie with the visitor's A/B
 *   groups. A server component can't set a cookie and the proxy runs before
 *   the page decides, so the page renders a one-line script that sets it,
 *   the same cookie v7's `persistFlags` sent:
 *   `deco_segment=<value>; Max-Age=31536000; Path=/; SameSite=Lax`.
 *   Render it after the content resolved (the matchers ran), as the last
 *   child of the page. A page that reads the request is dynamic, so Next
 *   never shares it between visitors.
 *
 * ```tsx
 * // the block map
 * "website/matchers/random.ts": async (props: RandomProps) => random(props, await matcherContext()),
 *
 * // app/[[...path]]/page.tsx
 * const sections = await resolvePage(...);   // runs the matchers
 * return <>{sections}<SegmentCookie /></>;
 * ```
 */
import { headers } from "next/headers.js";
import { cache, createElement, type ReactElement } from "react";
import { type Device, detectDevice } from "../device.ts";
import type { MatcherContext } from "../matchers/context.ts";
import { type StoredFlag, segmentSetCookie } from "../matchers/segment.ts";
import { PAGE_URL_HEADER } from "./shared.ts";

export type { Device } from "../device.ts";
export type { MatcherContext, StoredFlag } from "../matchers/index.ts";
export { PAGE_URL_HEADER };

interface RequestState {
  flags: StoredFlag[];
  request?: Request;
  contexts: Map<string, MatcherContext>;
}

/** One state per request: React's `cache` is scoped to the server render of a request. */
const requestState = cache((): RequestState => ({ flags: [], contexts: new Map() }));

/** The request's device: v7's `detectDevice` on its user agent. */
export async function requestDevice(): Promise<Device> {
  return detectDevice((await headers()).get("user-agent") ?? "");
}

/**
 * The matchers' input for the request being rendered: a `Request` with its
 * headers at the page's URL, and the request's `flags`. The URL is `pageUrl`,
 * else the one the site's proxy forwarded on `x-deco-page-url`. The same
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
    context = { request: state.request, url, flags: state.flags };
    state.contexts.set(url, context);
  }
  return context;
}

export interface SegmentCookieProps {
  /** The CSP nonce for the inline script, when the site enforces one. */
  nonce?: string;
}

/**
 * The script that sets `deco_segment` to keep this request's A/B decisions,
 * merged over the visitor's cookie; nothing when no matcher decided or the
 * cookie already says the same.
 */
export function SegmentCookie({ nonce }: SegmentCookieProps = {}): ReactElement | null {
  const state = requestState();
  if (!state.request) return null;
  const value = segmentSetCookie(state.request, state.flags);
  if (value === null) return null;
  return createElement("script", {
    nonce,
    dangerouslySetInnerHTML: { __html: segmentCookieScript(value) },
  });
}

/** `document.cookie = <Set-Cookie value>`, inert inside a `<script>`. */
export function segmentCookieScript(setCookie: string): string {
  return `document.cookie=${JSON.stringify(setCookie).replace(/</g, "\\u003c")}`;
}
