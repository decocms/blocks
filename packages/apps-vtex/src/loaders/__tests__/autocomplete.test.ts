import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureVtex, setVtexFetch } from "../../client";
import { clearFetchCache } from "../../utils/fetchCache";
import { autocompleteSearch } from "../autocomplete";

describe("autocompleteSearch — searchId", () => {
  const mockProductSearch = (body: Record<string, unknown>) => {
    const mock = vi.fn((url: string) => {
      const isProductSearch = new URL(url).pathname.includes("/product_search/");
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(isProductSearch ? body : { searches: [] }),
      } as Response);
    });
    setVtexFetch(mock as unknown as typeof fetch);
    return mock;
  };

  beforeEach(() => {
    clearFetchCache();
    configureVtex({ account: "testaccount" });
  });

  afterEach(() => {
    setVtexFetch(globalThis.fetch);
  });

  it("returns the searchId of the product_search response", async () => {
    mockProductSearch({ products: [], searchId: "search-1" });
    const result = await autocompleteSearch({ query: "camisa" });
    expect(result.searchId).toBe("search-1");
  });

  it("leaves it undefined when the response has none", async () => {
    mockProductSearch({ products: [] });
    const result = await autocompleteSearch({ query: "camisa" });
    expect(result.searchId).toBeUndefined();
  });

  it("has none for an empty query, which searches nothing", async () => {
    const mock = mockProductSearch({ products: [], searchId: "search-1" });
    const result = await autocompleteSearch({ query: "  " });
    expect(result).toEqual({ searches: [], products: [] });
    expect(mock).not.toHaveBeenCalled();
  });

  it("has none when the search fails", async () => {
    setVtexFetch((() => Promise.reject(new Error("network"))) as unknown as typeof fetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await autocompleteSearch({ query: "camisa" });
    expect(result).toEqual({ searches: [], products: [] });
    consoleError.mockRestore();
  });
});
