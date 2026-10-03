/**
 * The Wake client: a thin, typed client for Wake's Storefront GraphQL API and
 * the one checkout REST call a storefront needs, over the framework's
 * instrumented fetch (provider "wake"). See /next/upstream-clients.
 *
 * Configuration comes in as arguments; the site reads its environment where
 * it creates the client. Converters, hooks, cart/session flows, caching and
 * proxying belong to the site (platform templates), not here.
 */
import { createInstrumentedFetch, type InstrumentedFetchOptions } from "@decocms/blocks/fetch";
import type { UserAuthenticate } from "./utils/client";
import { buildQuery, type QueryDefinition } from "./utils/gql";
import { extractGraphqlOperationName } from "./utils/graphqlOperationName";

export const WAKE_STOREFRONT_ENDPOINT = "https://storefront-api.fbits.net/graphql";

export interface WakeClientConfig {
  /** Wake Storefront API token, sent as `TCS-Access-Token`. */
  storefrontToken: string;
  /** Storefront GraphQL endpoint; defaults to Wake's multi-tenant endpoint. */
  storefrontEndpoint?: string;
  /** Checkout origin, e.g. `https://checkout.example.com`; defaults to `https://<account>.checkout.fbits.store`. */
  checkoutUrl?: string;
  /** Wake account name; only used to derive the default `checkoutUrl`. */
  account?: string;
}

export interface WakeClientOptions {
  /** The fetch underneath, e.g. a fake in tests. Defaults to `globalThis.fetch`. */
  fetch?: InstrumentedFetchOptions["fetch"];
}

/** Thrown on a non-2xx response or a GraphQL `errors` payload. Never carries bodies or tokens. */
export class WakeError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    /** How many GraphQL errors the response carried (0 for an HTTP failure). */
    readonly graphqlErrors = 0,
  ) {
    super(
      graphqlErrors > 0
        ? `wake ${operation} returned ${graphqlErrors} GraphQL error(s)`
        : `wake ${operation} failed with HTTP ${status}`,
    );
    this.name = "WakeError";
  }
}

export type WakeClient = ReturnType<typeof createWakeClient>;

export function createWakeClient(config: WakeClientConfig, options: WakeClientOptions = {}) {
  const request = createInstrumentedFetch({ provider: "wake", fetch: options.fetch });
  const endpoint = config.storefrontEndpoint || WAKE_STOREFRONT_ENDPOINT;
  const checkoutUrl =
    config.checkoutUrl || (config.account ? `https://${config.account}.checkout.fbits.store` : "");

  return {
    /**
     * Run a Storefront GraphQL operation (see `@decocms/apps-wake/storefront`).
     * The operation label is the document's operation name. `headers` adds
     * per-call headers, such as `X-Forwarded-For` or a customer access token;
     * they never override the token or the content type.
     */
    async graphql<TData, TVariables = Record<string, unknown>>(
      document: string | QueryDefinition,
      variables?: TVariables,
      init: { headers?: Record<string, string> } = {},
    ): Promise<TData> {
      const query = typeof document === "string" ? document : buildQuery(document);
      const operation = extractGraphqlOperationName(query) ?? "graphql";
      const response = await request(endpoint, {
        operation,
        method: "POST",
        headers: {
          ...init.headers,
          "content-type": "application/json",
          "tcs-access-token": config.storefrontToken,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new WakeError(operation, response.status);
      const body = (await response.json()) as { data?: TData; errors?: unknown[] };
      if (body.errors?.length) throw new WakeError(operation, response.status, body.errors.length);
      if (body.data === undefined) throw new WakeError(operation, response.status);
      return body.data;
    },

    /**
     * `GET /api/Login/Get` on the checkout: exchanges the shopper's checkout
     * cookies (the `fbits-login` cookie) for their account, or `null` when
     * they aren't signed in (a 4xx).
     */
    async getLogin(cookie: string): Promise<UserAuthenticate | null> {
      if (!checkoutUrl) throw new Error("wake getLogin: set checkoutUrl or account");
      const response = await request(new URL("/api/Login/Get", checkoutUrl), {
        operation: "getLogin",
        headers: { cookie },
      });
      if (response.status >= 400 && response.status < 500) return null; // not signed in
      if (!response.ok) throw new WakeError("getLogin", response.status);
      return (await response.json()) as UserAuthenticate | null;
    },
  };
}
