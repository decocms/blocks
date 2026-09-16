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

export const decoStringifySearch: SearchSerializer = (search) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null || value === "") continue;
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

  return createTanStackRouter({
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
}
