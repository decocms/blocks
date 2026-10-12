// upstream-clients.mdx › Write a client, verbatim.
import { createInstrumentedFetch } from "@decocms/blocks/fetch";

export interface AcmeSearchConfig {
  endpoint: string;   // e.g. https://api.acme-search.example
  apiKey: string;
}

export interface ProductHit {
  sku: string;
  name: string;
  price: number;
  image: string;
  url: string;
}

export class AcmeSearchError extends Error {
  constructor(readonly operation: string, readonly status: number) {
    super(`acme-search ${operation} failed with HTTP ${status}`);   // no body, no key
  }
}

export function createAcmeSearch(config: AcmeSearchConfig, options: { fetch?: typeof fetch } = {}) {
  // Every request through this fetch is timed and labeled as provider "acme-search".
  const request = createInstrumentedFetch({ provider: "acme-search", fetch: options.fetch });

  return {
    async search(query: string, limit = 10): Promise<ProductHit[]> {
      const url = new URL("/v1/search", config.endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(limit));

      const response = await request(url, {
        operation: "search",                                    // the operation label
        headers: { authorization: `Bearer ${config.apiKey}` },
      });
      if (!response.ok) throw new AcmeSearchError("search", response.status);

      const body = (await response.json()) as { hits: ProductHit[] };
      return body.hits;
    },
  };
}
