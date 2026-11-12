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
 * is the site's job.
 */
import { createInstrumentedFetch, reportUpstreamError } from "@decocms/blocks/fetch";
import { extractGraphqlOperationName } from "./graphqlOperationName.ts";

// Shopify can return these failures with HTTP 200. Only fixed codes cross
// the error/log boundary: upstream messages and arbitrary codes can contain
// customer data. Unknown failures remain errors so they aren't hidden.
const WARNING_CODES = new Set([
  "THROTTLED",
  "ACCESS_DENIED",
  "SHOP_INACTIVE",
  "MAX_COST_EXCEEDED",
  "GRAPHQL_PARSE_FAILED",
  "GRAPHQL_VALIDATION_FAILED",
  "BAD_USER_INPUT",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  const extensions = isRecord(error) ? error.extensions : undefined;
  const code = isRecord(extensions) ? extensions.code : undefined;
  return typeof code === "string" && (code === "INTERNAL_SERVER_ERROR" || WARNING_CODES.has(code))
    ? code
    : "UNKNOWN";
}

export interface ShopifyClientConfig {
  /** The store's subdomain: "acme" for acme.myshopify.com. */
  storeName: string;
  /** Storefront API access token. */
  storefrontAccessToken: string;
  /** Admin API access token; `admin` is only available when it's set. */
  adminAccessToken?: string;
  /** The Shopify API version, e.g. "2026-07". The site owns it, so there is no default to go stale. */
  apiVersion: string;
}

interface ShopifyRequestOptions {
  /** Extra request headers, e.g. `Shopify-Storefront-Buyer-IP`. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** One GraphQL endpoint: send a document, get its `data` back. */
interface ShopifyGraphQL {
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
  const version = config.apiVersion;

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
        function reject(codes: string[]): never {
          reportUpstreamError({
            provider: "shopify",
            operation,
            status: response.status,
            code: codes.join(","),
            severity: codes.every((code) => WARNING_CODES.has(code)) ? "warn" : "error",
          });
          throw new ShopifyError(operation, response.status, codes);
        }

        // A non-JSON body (an HTML error page) must not reach the error: the
        // SyntaxError's message quotes the start of the body.
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          reject(["INVALID_JSON"]);
        }
        if (!isRecord(body) || (body.errors != null && !Array.isArray(body.errors))) {
          reject(["INVALID_RESPONSE"]);
        }
        // Partial data alongside errors is rejected as a whole, deliberately:
        // a thin client doesn't guess which fields are still trustworthy.
        if (Array.isArray(body.errors) && body.errors.length > 0) {
          reject([...new Set(body.errors.map(errorCode))]);
        }
        if (body.data == null) reject(["MISSING_DATA"]);
        if (!isRecord(body.data)) reject(["INVALID_RESPONSE"]);
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
