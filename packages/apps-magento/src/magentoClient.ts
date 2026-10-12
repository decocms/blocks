/**
 * The Magento client: a thin client for a Magento store's REST and GraphQL
 * APIs, over the framework's instrumented fetch (provider "magento"). See
 * /next/upstream-clients.
 *
 * Configuration comes in as arguments; the site reads its environment (or a
 * `secret` block) where it creates the client. Converters, hooks, cart and
 * session flows, caching and feature toggles belong to the site (platform
 * templates), not here.
 */
import { createInstrumentedFetch } from "@decocms/blocks/fetch";

export interface MagentoClientConfig {
  /** The store's origin, e.g. `https://store.example.com`. Every request goes here. */
  baseUrl: string;
  /** Integration access token, sent as `Authorization: Bearer` unless a call opts out. */
  apiKey?: string;
  /** Optional value sent as `x-origin-header`, for stores behind an origin guard. */
  originHeader?: string;
}

export interface MagentoClientOptions {
  /** The fetch underneath, e.g. a fake in tests. Defaults to `globalThis.fetch`. */
  fetch?: Parameters<typeof createInstrumentedFetch>[0]["fetch"];
}

export interface MagentoRequestInit extends RequestInit {
  /** The operation label, the API's own name for the call (e.g. `getCart`), never a URL. */
  operation: string;
  /**
   * Send the `apiKey` bearer token. Default true for `request`/`rest`, false
   * for `graphql`. Never replaces an `Authorization` header the call sets
   * (e.g. a customer token).
   */
  authenticated?: boolean;
}

/** Thrown on a non-2xx response or a GraphQL `errors` payload. Never carries bodies or tokens. */
export class MagentoError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    /** How many GraphQL errors the response carried (0 for an HTTP failure). */
    readonly graphqlErrors = 0,
  ) {
    super(
      graphqlErrors > 0
        ? `magento ${operation} returned ${graphqlErrors} GraphQL error(s)`
        : `magento ${operation} failed with HTTP ${status}`,
    );
    this.name = "MagentoError";
  }
}

export type MagentoClient = ReturnType<typeof createMagentoClient>;

export function createMagentoClient(
  config: MagentoClientConfig,
  options: MagentoClientOptions = {},
) {
  const instrumented = createInstrumentedFetch({ provider: "magento", fetch: options.fetch });
  const origin = new URL(config.baseUrl).origin;

  /**
   * A request to a path on the store, e.g. `/rest/default/V1/carts/mine` or
   * `/customer/section/load`, returning the raw response. Paths only: the
   * store's credentials never go to another origin.
   */
  async function request(path: string, init: MagentoRequestInit): Promise<Response> {
    const { operation, authenticated = true, ...rest } = init;
    const url = new URL(path, origin);
    if (url.origin !== origin) {
      throw new Error(`magento ${operation}: only paths on the configured store are allowed`);
    }
    const headers = new Headers(rest.headers);
    if (authenticated && config.apiKey && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${config.apiKey}`);
    }
    if (config.originHeader) headers.set("x-origin-header", config.originHeader);
    return instrumented(url, { ...rest, headers, operation });
  }

  return {
    request,

    /** A REST call (`/rest/<store>/V1/...`) returning its parsed JSON body. */
    async rest<T>(path: string, init: MagentoRequestInit): Promise<T> {
      const headers = new Headers(init.headers);
      if (init.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      const response = await request(path, { ...init, headers });
      if (!response.ok) throw new MagentoError(init.operation, response.status);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    },

    /**
     * A GraphQL operation on `/graphql`. `operationName` is sent with the
     * request and is the operation label. `headers` adds per-call headers,
     * such as `Store` or a customer `Authorization` token. Storefront
     * GraphQL is public, so the `apiKey` is sent only with
     * `authenticated: true`, and never over a customer token.
     */
    async graphql<TData, TVariables = Record<string, unknown>>(
      query: string,
      variables: TVariables | undefined,
      init: { operationName: string; headers?: Record<string, string>; authenticated?: boolean },
    ): Promise<TData> {
      const { operationName, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("content-type", "application/json");
      const response = await request("/graphql", {
        operation: operationName,
        authenticated: rest.authenticated ?? false,
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables, operationName }),
      });
      if (!response.ok) throw new MagentoError(operationName, response.status);
      const body = (await response.json()) as { data?: TData; errors?: unknown[] };
      if (body.errors?.length) {
        throw new MagentoError(operationName, response.status, body.errors.length);
      }
      if (body.data === undefined) throw new MagentoError(operationName, response.status);
      return body.data;
    },
  };
}
