/**
 * The router factory every Deco TanStack site uses (isomorphic).
 *
 * Search params use plain `URLSearchParams`, not TanStack's JSON format, so
 * commerce URLs such as `?filter.size=M&filter.size=L` round-trip unchanged.
 */
import {
  type AnyRoute,
  createRouter,
  type SearchParser,
  type SearchSerializer,
  type TrailingSlashOption,
} from "@tanstack/react-router";
import type { JSX } from "react";

export { PAGE_STATUS_HEADER } from "../shared.ts";

export const decoParseSearch: SearchParser = (searchStr) => {
  const str = searchStr.startsWith("?") ? searchStr.slice(1) : searchStr;
  if (!str) return {};
  const params = new URLSearchParams(str);
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? (values[0] as string) : values;
  }
  return result;
};

/**
 * The inverse of {@link decoParseSearch}, and a fixed point of it: on the
 * server, TanStack Router compares the request's URL with
 * `stringifySearch(parseSearch(...))` and redirects (307) when they differ, so
 * an empty value (`?q=`, `?sort=`) must be kept, as v7 #646 fixed.
 * `undefined` and `null` still remove a param (`navigate({ search: { q: undefined } })`).
 */
export const decoStringifySearch: SearchSerializer = (search) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  const str = params.toString();
  return str ? `?${str}` : "";
};

export interface DecoRouterOptions<TRouteTree extends AnyRoute> {
  routeTree: TRouteTree;
  /** Router context for every route (e.g. `{ queryClient }`). */
  context?: Record<string, unknown>;
  /** A provider around the whole app (non-DOM only, e.g. `QueryClientProvider`). */
  Wrap?: (props: { children: any }) => JSX.Element;
  /** The CSP nonce TanStack stamps on its own scripts, when the site enforces one. */
  nonce?: string;
  /** Default `"intent"`. */
  defaultPreload?: "intent" | "viewport" | "render" | false;
  trailingSlash?: TrailingSlashOption;
}

/**
 * `createRouter` with Deco's defaults: `URLSearchParams` search params that
 * keep empty values, scroll restoration, preload on intent.
 */
export function createDecoRouter<TRouteTree extends AnyRoute>(
  options: DecoRouterOptions<TRouteTree>,
) {
  const { routeTree, context, Wrap, nonce, defaultPreload = "intent", trailingSlash } = options;
  return createRouter({
    routeTree,
    context: context as any,
    Wrap,
    scrollRestoration: true,
    defaultPreload,
    trailingSlash,
    parseSearch: decoParseSearch,
    stringifySearch: decoStringifySearch,
    ...(nonce ? { ssr: { nonce } } : {}),
  });
}
