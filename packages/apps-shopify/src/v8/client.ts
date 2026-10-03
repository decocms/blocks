/**
 * The Shopify upstream client (/next/upstream-clients): the Storefront and
 * Admin GraphQL APIs over the framework's instrumented fetch, and nothing
 * else. Converters to commerce types, cart and customer flows, hooks and
 * loaders live in the Shopify platform template and site code.
 *
 * Every request is measured as provider "shopify", labeled with the GraphQL
 * operation's own name (`query ProductByHandle { … }` → "ProductByHandle"),
 * or "storefront.graphql" / "admin.graphql" for an unnamed document. Retries
 * and the circuit breaker stay off, as for every client but VTEX's; caching
 * is the framework binding's job.
 */
import { createInstrumentedFetch } from "@decocms/blocks/fetch";
import { extractGraphqlOperationName } from "../utils/graphqlOperationName";

/** The Shopify API version used when the config names none. */
export const DEFAULT_SHOPIFY_API_VERSION = "2025-04";

export interface ShopifyClientConfig {
  /** The store's subdomain: "acme" for acme.myshopify.com. */
  storeName: string;
  /** Storefront API access token. */
  storefrontAccessToken: string;
  /** Admin API access token; `admin` is only available when it's set. */
  adminAccessToken?: string;
  /** e.g. "2025-04"; defaults to DEFAULT_SHOPIFY_API_VERSION. */
  apiVersion?: string;
}

export interface ShopifyRequestOptions {
  /** Extra request headers, e.g. `Shopify-Storefront-Buyer-IP`. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** One GraphQL endpoint: send a document, get its `data` back. */
export interface ShopifyGraphQL {
  query<T, V extends Record<string, unknown> = Record<string, unknown>>(
    document: string,
    variables?: V,
    options?: ShopifyRequestOptions,
  ): Promise<T>;
}

export interface ShopifyClient {
  storefront: ShopifyGraphQL;
  /** Throws when called without `adminAccessToken` in the config. */
  admin: ShopifyGraphQL;
}

/** A failed request. Carries the operation, the HTTP status and Shopify's error codes; never bodies or tokens. */
export class ShopifyError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly codes: string[] = [],
  ) {
    super(
      codes.length > 0
        ? `shopify ${operation} returned GraphQL errors (${codes.join(", ")})`
        : `shopify ${operation} failed with HTTP ${status}`,
    );
    this.name = "ShopifyError";
  }
}

export function createShopifyClient(
  config: ShopifyClientConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
): ShopifyClient {
  const request = createInstrumentedFetch({ provider: "shopify", fetch: options.fetch });
  const origin = `https://${config.storeName}.myshopify.com`;
  const version = config.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION;

  const endpoint = (surface: "storefront" | "admin", url: string, auth: Record<string, string>) =>
    ({
      async query(document, variables, { headers, signal } = {}) {
        const operation = extractGraphqlOperationName(document) ?? `${surface}.graphql`;
        const response = await request(url, {
          operation,
          method: "POST",
          headers: { "content-type": "application/json", ...headers, ...auth },
          body: JSON.stringify({ query: document, variables }),
          signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new ShopifyError(operation, response.status);
        }
        const body = (await response.json()) as {
          data?: unknown;
          errors?: { extensions?: { code?: unknown } }[];
        };
        if (body.errors?.length || body.data == null) {
          const codes = body.errors?.length
            ? body.errors.map((e) =>
                typeof e.extensions?.code === "string" ? e.extensions.code : "UNKNOWN",
              )
            : ["MISSING_DATA"];
          throw new ShopifyError(operation, response.status, [...new Set(codes)]);
        }
        return body.data as never;
      },
    }) satisfies ShopifyGraphQL;

  const adminToken = config.adminAccessToken;
  return {
    storefront: endpoint("storefront", `${origin}/api/${version}/graphql.json`, {
      "x-shopify-storefront-access-token": config.storefrontAccessToken,
    }),
    admin: adminToken
      ? endpoint("admin", `${origin}/admin/api/${version}/graphql.json`, {
          "x-shopify-access-token": adminToken,
        })
      : {
          query: () =>
            Promise.reject(
              new Error("shopify admin: pass adminAccessToken to createShopifyClient"),
            ),
        },
  };
}
