/**
 * Deco-flavored TanStack Router factory.
 *
 * Uses standard URLSearchParams serialization instead of TanStack's default
 * JSON-based format. Required because VTEX (and most commerce platforms) uses
 * filter URLs like `?filter.brand=Nike&filter.brand=Adidas` which must
 * round-trip correctly through the router's search system.
 */

import { getRequestNonce } from "@decocms/blocks/sdk/nonce";
import type {
  AnyRoute,
  SearchParser,
  SearchSerializer,
  TrailingSlashOption,
} from "@tanstack/react-router";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

export const decoParseSearch: SearchParser = (searchStr) => {
  const str = searchStr.startsWith("?") ? searchStr.slice(1) : searchStr;
  if (!str) return {};

  const params = new URLSearchParams(str);
  const result: Record<string, string | string[]> = {};

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
};

/**
 * Serializes the router's search object back to a query string.
 *
 * Must be a fixed point of {@link decoParseSearch}: on the server, TanStack
 * Router compares the request's href with `stringifySearch(parseSearch(...))`
 * (`router.beforeLoad`) and answers a 307 to the normalized URL when they
 * differ. A value-less parameter (`?sort=`, `?utm_source=`) parses to `""`,
 * so dropping `""` here turned every such request into a redirect that
 * Fresh — and TanStack's own default serializer, which only drops
 * `undefined` — never issued. `undefined`/`null` still remove a param, which
 * is how `navigate({ search: { q: undefined } })` clears one.
 */
export const decoStringifySearch: SearchSerializer = (search) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  const str = params.toString();
  return str ? `?${str}` : "";
};

export interface CreateDecoRouterOptions {
  routeTree: AnyRoute;
  scrollRestoration?: boolean;
  defaultPreload?: "intent" | "viewport" | "render" | false;
  trailingSlash?: TrailingSlashOption;
  /**
   * Router context — passed to all route loaders/components via routeContext.
   * Commonly used for { queryClient } per TanStack Query integration docs.
   */
  context?: Record<string, unknown>;
  /**
   * Non-DOM provider component to wrap the entire router.
   * Per TanStack docs, only non-DOM-rendering components (providers) should
   * be used — anything else causes hydration errors.
   *
   * Example: QueryClientProvider wrapping
   *   Wrap: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
   */
  Wrap?: (props: { children: any }) => any;
}

/**
 * Create a TanStack Router with Deco defaults:
 * - URLSearchParams-based search serialization (not JSON)
 * - Scroll restoration enabled
 * - Preload on intent
 */
export function createDecoRouter(options: CreateDecoRouterOptions) {
  const {
    routeTree,
    scrollRestoration = true,
    defaultPreload = "intent",
    trailingSlash,
    context,
    Wrap,
  } = options;

  // On the server, `getRouter()` runs per request inside `RequestContext.run`,
  // so this reads the request's CSP nonce (enforce mode) — `ScriptOnce` and
  // TanStack's own hydration scripts read `router.options.ssr.nonce` and stamp
  // it. `undefined` in report-only mode and on the client, where it's a no-op.
  const nonce = getRequestNonce();

  const router = createTanStackRouter({
    routeTree,
    scrollRestoration,
    defaultPreload,
    trailingSlash,
    context: context as any,
    Wrap,
    parseSearch: decoParseSearch,
    stringifySearch: decoStringifySearch,
    ...(nonce ? { ssr: { nonce } } : {}),
  });

  // Registered after the constructor, where router-core adds its own
  // `pageshow` listener, so this one runs after it in the same dispatch.
  if (scrollRestoration && typeof window !== "undefined") keepBfcacheScroll(window);

  return router;
}

/** How long the browser gets to restore a bfcache page before the router takes scroll back. */
const BFCACHE_SCROLL_HANDBACK_MS = 1000;

/**
 * router-core sets `history.scrollRestoration = "auto"` on `pagehide` and back
 * to `"manual"` on a persisted `pageshow` (scroll-restoration.js, from
 * TanStack/router#8519). On iOS Safari that `pageshow` runs before WebKit
 * restores the page's scroll, and with `"manual"` WebKit skips it: a page
 * restored from the back/forward cache comes back at the top. No navigation
 * happens on a bfcache resume, so the router does not restore it either.
 *
 * Put `"auto"` back for the resume, and hand scroll back to the router
 * (`"manual"`) once the browser has restored it — on the first scroll event,
 * or after {@link BFCACHE_SCROLL_HANDBACK_MS} when the page was at the top and
 * nothing scrolls — so in-app traversals keep the router's restoration.
 *
 * Returns a function that removes the listener (for tests).
 *
 * @internal Exported for tests.
 */
export function keepBfcacheScroll(win: Window): () => void {
  const onPageshow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    win.history.scrollRestoration = "auto";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handBack = () => {
      win.removeEventListener("scroll", handBack);
      if (timer !== undefined) clearTimeout(timer);
      win.history.scrollRestoration = "manual";
    };
    win.addEventListener("scroll", handBack, { once: true, passive: true });
    timer = setTimeout(handBack, BFCACHE_SCROLL_HANDBACK_MS);
  };
  win.addEventListener("pageshow", onPageshow);
  return () => win.removeEventListener("pageshow", onPageshow);
}
