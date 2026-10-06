/**
 * Nuvemshop (Tiendanube) Storefront API client.
 *
 * REST over `https://storefront-api.tiendanube.com/<version>/stores/<id>`.
 * Access is tokenless (120 req/min per store + client IP) or with a
 * store-scoped bearer token (1,200 req/min per store). From a Worker every
 * buyer shares the egress IP, so production stores should configure a token.
 *
 * - GETs go through the shared SWR cache (`createFetchCache`) keyed by URL.
 * - POSTs forward the buyer IP (`X-LinkedStore-Buyer-IP`) when a token is
 *   set, giving each buyer their own rate-limit bucket. Tokenless requests
 *   ignore that header, so it's only sent with a token.
 * - Transport defaults to the instrumented `createNuvemshopFetch()`.
 */

import { createFetchCache } from "@decocms/blocks/sdk/fetchCache";
import type { FetchFn } from "@decocms/blocks/sdk/fetchTimeout";
import { createNuvemshopFetch } from "./utils/instrumentedFetch";

export interface NuvemshopConfig {
  storeId: string;
  /** Store-scoped Storefront token. Optional; recommended in production. */
  token?: string;
  /** Default "v2026-11". */
  apiVersion?: string;
  /** Default "https://storefront-api.tiendanube.com". */
  baseUrl?: string;
  /** Currency of the store's prices (the API doesn't return one). Default "BRL". */
  currency?: string;
}

/**
 * Root fields requested for every product. The API's default selection is
 * only `id,name,handle`. `cost` is deliberately absent.
 */
export const PRODUCT_FIELDS = [
  "id",
  "name",
  "handle",
  "description",
  "images",
  "variants",
  "brand",
  "tags",
  "categories",
  "attributes",
  "seo_title",
  "seo_description",
  "free_shipping",
  "video_url",
  "created_at",
].join(",");

/** The default category selection also lacks `parent`, which breaks trees and breadcrumbs. */
export const CATEGORY_FIELDS =
  "id,name,handle,parent,subcategories,description,seo_title,seo_description";

const DEFAULT_FIELDS: [RegExp, string][] = [
  [/^\/(search\/)?products(\/|$)/, PRODUCT_FIELDS],
  [/^\/categories(\/|$)/, CATEGORY_FIELDS],
];

let _config: NuvemshopConfig | null = null;
let _fetch: FetchFn | undefined;

const cache = createFetchCache({
  provider: "nuvemshop",
  maxEntries: 500,
  // Catalog doesn't need to be second-fresh; a just-published product shouldn't 404 long.
  freshTtlMs: { success: 120_000, notFound: 10_000, serverError: 0 },
  staleIfErrorMs: 86_400_000,
  inflightBackstopMs: 15_000,
});

export function configureNuvemshop(config: NuvemshopConfig | null) {
  _config = config;
}

export function getNuvemshopConfig(): NuvemshopConfig {
  if (!_config)
    throw new Error(
      "Nuvemshop is not configured — add a deco-nuvemshop block or call configureNuvemshop()",
    );
  return _config;
}

/** Override the transport (tests, or a site wrapping its own fetch). */
export function setNuvemshopFetch(fn: FetchFn) {
  _fetch = fn;
}

export function clearNuvemshopCache() {
  cache.clear();
}

const transport = () => (_fetch ??= createNuvemshopFetch() as FetchFn);

function storeUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  const {
    storeId,
    apiVersion = "v2026-11",
    baseUrl = "https://storefront-api.tiendanube.com",
  } = getNuvemshopConfig();
  const url = new URL(`${baseUrl}/${apiVersion}/stores/${storeId}${path}`);
  const fields = DEFAULT_FIELDS.find(([route]) => route.test(path))?.[1];
  if (fields && params.fields === undefined) params = { ...params, fields };
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  return url.toString();
}

function headers(extra?: Record<string, string>) {
  const { token } = getNuvemshopConfig();
  return {
    accept: "application/json",
    ...(token && { authorization: `Bearer ${token}` }),
    ...extra,
  };
}

async function errorFrom(res: Response) {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  return new Error(
    `Nuvemshop ${res.status} ${body?.error?.code ?? ""}: ${body?.error?.message ?? res.statusText}`,
  );
}

/** Cached GET. Resolves `null` on 404 (and other cacheable non-2xx). */
export function nuvemshopGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T | null> {
  try {
    const url = storeUrl(path, params);
    return cache.fetchWithCache<T>(url, () => transport()(url, { headers: headers() }));
  } catch (e) {
    return Promise.reject(e);
  }
}

export async function nuvemshopPost<T>(
  path: string,
  body: unknown,
  opts: { buyerIp?: string | null } = {},
): Promise<T> {
  const url = storeUrl(path);
  const { token } = getNuvemshopConfig();
  const res = await transport()(url, {
    method: "POST",
    headers: headers({
      "content-type": "application/json",
      ...(token && opts.buyerIp && { "x-linkedstore-buyer-ip": opts.buyerIp }),
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}
