/**
 * The v8 Algolia client (/next/upstream-clients): typed REST calls through
 * the instrumented fetch, credentials in headers, errors without bodies.
 */
import { describe, expect, it, vi } from "vitest";
import { AlgoliaError, createAlgoliaClient } from "../index";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

const config = { applicationId: "APPID", apiKey: "search-key" };

describe("createAlgoliaClient", () => {
  it("search posts every query to the multi-query endpoint", async () => {
    const fetch = fakeFetch(200, { results: [{ hits: [{ objectID: "1" }], nbHits: 1 }] });
    const algolia = createAlgoliaClient(config, { fetch });

    const { results } = await algolia.search([
      { indexName: "products", query: "linen shirt", hitsPerPage: 12 },
    ]);

    expect(results[0].hits[0].objectID).toBe("1");
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://APPID-dsn.algolia.net/1/indexes/*/queries");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "x-algolia-application-id": "APPID",
      "x-algolia-api-key": "search-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      requests: [{ indexName: "products", query: "linen shirt", hitsPerPage: 12 }],
    });
  });

  it("searchSingleIndex posts the params to the index's query endpoint", async () => {
    const fetch = fakeFetch(200, { hits: [], nbHits: 0 });
    const algolia = createAlgoliaClient(config, { fetch });

    await algolia.searchSingleIndex("products price/asc", { query: "shirt" });

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://APPID-dsn.algolia.net/1/indexes/products%20price%2Fasc/query",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ query: "shirt" });
  });

  it("throws the operation and status, never the body or the key", async () => {
    const fetch = fakeFetch(403, { message: "Invalid API key search-key" });
    const algolia = createAlgoliaClient(config, { fetch });

    const error = await algolia.searchSingleIndex("products").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AlgoliaError);
    expect(error).toMatchObject({ operation: "searchSingleIndex", status: 403 });
    expect((error as Error).message).not.toContain("search-key");
  });

  it("does not retry", async () => {
    const fetch = fakeFetch(503, {});
    const algolia = createAlgoliaClient(config, { fetch });

    await expect(algolia.search([{ indexName: "products" }])).rejects.toThrow(AlgoliaError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
