/**
 * `@decocms/apps-algolia`: a thin client for the Algolia Search REST API.
 * See /next/upstream-clients.
 *
 * It calls the REST API directly rather than through the `algoliasearch`
 * SDK, so every request goes through `createInstrumentedFetch` (provider
 * `algolia`) like every other client. No retries or circuit breaker, and no
 * response cache: caching upstream data is the site's job.
 */
import { createInstrumentedFetch } from "@decocms/blocks/fetch";

export interface AlgoliaClientConfig {
  applicationId: string;
  /** A search-only key is enough for search; never send an admin key to the browser. */
  apiKey: string;
}

/** One query: the index plus search parameters as the REST API names them (`query`, `hitsPerPage`, `filters`, ...). */
export interface AlgoliaSearchRequest {
  indexName: string;
  query?: string;
  [param: string]: unknown;
}

export type AlgoliaHit<T> = T & { objectID: string; [field: string]: unknown };

export interface AlgoliaSearchResponse<T = Record<string, unknown>> {
  hits: AlgoliaHit<T>[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
  processingTimeMS: number;
  query: string;
  params: string;
  index?: string;
  queryID?: string;
  facets?: Record<string, Record<string, number>>;
  [field: string]: unknown;
}

export class AlgoliaError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`algolia ${operation} failed with HTTP ${status}`);
  }
}

export function createAlgoliaClient(
  config: AlgoliaClientConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
) {
  // The id becomes part of the host; reject anything that could redirect the API key elsewhere.
  if (!/^[A-Za-z0-9]+$/.test(config.applicationId))
    throw new Error("algolia: invalid applicationId");
  const request = createInstrumentedFetch({ provider: "algolia", fetch: options.fetch });
  const host = `https://${config.applicationId}-dsn.algolia.net`;

  async function post<R>(operation: string, path: string, body: unknown): Promise<R> {
    const response = await request(`${host}${path}`, {
      operation,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-algolia-application-id": config.applicationId,
        "x-algolia-api-key": config.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new AlgoliaError(operation, response.status);
    return (await response.json()) as R;
  }

  return {
    /** Runs several queries, on one or more indices, in one request. */
    search<T = Record<string, unknown>>(
      requests: AlgoliaSearchRequest[],
    ): Promise<{ results: AlgoliaSearchResponse<T>[] }> {
      return post("search", "/1/indexes/*/queries", { requests });
    },
  };
}

export type AlgoliaClient = ReturnType<typeof createAlgoliaClient>;
