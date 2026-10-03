import { type FetchFn, withFetchTimeout } from "@decocms/blocks/sdk/fetchTimeout";
import type { InstrumentedFetchInit } from "@decocms/blocks/sdk/instrumentedFetch";
import { buildQuery, type QueryDefinition } from "./gql";
import { extractGraphqlOperationName } from "./graphqlOperationName";

export { buildQuery, gql, type QueryDefinition } from "./gql";

export interface GraphQLClient {
  /**
   * Run a GraphQL operation. `extraHeaders` is merged over the client's
   * base headers for the single call — Wake loaders use it to forward the
   * client IP (`X-Forwarded-For`) via `parseHeaders(...)`.
   */
  query<T>(
    query: string | QueryDefinition,
    variables?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export function createGraphqlClient(
  endpoint: string,
  headers: Record<string, string>,
  fetchFn?: FetchFn,
): GraphQLClient {
  const _fetch = fetchFn ?? withFetchTimeout();
  return {
    async query<T>(
      queryOrDef: string | QueryDefinition,
      variables?: Record<string, unknown>,
      extraHeaders?: Record<string, string>,
    ): Promise<T> {
      const query = typeof queryOrDef === "string" ? queryOrDef : buildQuery(queryOrDef);

      // Stamp the GraphQL operation as init.operation so the framework's
      // span name becomes `wake.<OperationName>` instead of the generic
      // `wake.storefront.graphql` from the URL router. The extra field is
      // silently dropped by plain `fetch` and read by any `InstrumentedFetch`
      // configured via `setWakeFetch`.
      const operation = extractGraphqlOperationName(query);
      const init: InstrumentedFetchInit = {
        method: "POST",
        headers: {
          // Per-call `extraHeaders` (e.g. forwarded client IP) come first so
          // they can never override the app's auth token or Content-Type.
          ...extraHeaders,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ query, variables }),
        ...(operation ? { operation } : {}),
      };
      const response = await _fetch(endpoint, init);

      if (!response.ok) {
        throw new Error(`Wake GraphQL error: ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

      if (json.errors?.length) {
        throw new Error(`Wake GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
      }

      if (json.data === undefined) {
        throw new Error("Wake GraphQL response missing data");
      }

      return json.data;
    },
  };
}
