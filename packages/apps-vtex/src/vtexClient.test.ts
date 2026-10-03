// @vitest-environment node
/**
 * The VTEX upstream client (/next/upstream-clients): typed calls over the
 * framework's instrumented fetch, labeled provider "vtex" with a named
 * operation, retries and a circuit breaker on by default, per-shopper inputs
 * as arguments, and errors that carry no body, URL, token or cookie.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const instrumented = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  operations: [] as (string | undefined)[],
}));

vi.mock("@decocms/blocks/fetch", async (importActual) => {
  const actual = await importActual<typeof import("@decocms/blocks/fetch")>();
  return {
    ...actual,
    createInstrumentedFetch: (options: Parameters<typeof actual.createInstrumentedFetch>[0]) => {
      instrumented.options.push(options as unknown as Record<string, unknown>);
      const request = actual.createInstrumentedFetch(options);
      return (input: string | URL | Request, init?: RequestInit & { operation?: string }) => {
        instrumented.operations.push(init?.operation);
        return request(input, init);
      };
    },
  };
});

import { createVtexClient, VtexError } from ".";

type Call = { url: string; init: RequestInit };

/** An upstream answering with `statuses` in order, recording each request. */
function upstream(statuses: number[] = [], headers: Record<string, string | string[]> = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = new Response('{"secret-body":"token-123"}', {
      status: statuses.shift() ?? 200,
    });
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) response.headers.append(name, v);
    }
    return response;
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

afterEach(() => {
  instrumented.options.length = 0;
  instrumented.operations.length = 0;
});

describe("createVtexClient", () => {
  it("uses the instrumented fetch as provider vtex, with retries and a circuit breaker on", () => {
    createVtexClient({ account: "store" });
    expect(instrumented.options[0]).toMatchObject({
      provider: "vtex",
      retry: { attempts: 2, backoffMs: 150 },
      circuitBreaker: { failures: 5, cooldownMs: 5000 },
    });
  });

  it("turns retries and the circuit breaker off when asked", () => {
    createVtexClient({ account: "store", retry: false, circuitBreaker: false });
    expect(instrumented.options[0]?.retry).toBeUndefined();
    expect(instrumented.options[0]?.circuitBreaker).toBeUndefined();
  });

  it("searches Intelligent Search with facets, region, locale and sales channel as arguments", async () => {
    const { calls, fetch } = upstream();
    const vtex = createVtexClient({
      account: "store",
      appKey: "key",
      appToken: "token",
      salesChannel: "2",
      locale: "pt-BR",
      fetch,
    });
    await vtex.search.products({
      query: "linen shirt",
      count: 12,
      facets: [{ key: "category-1", value: "shirts" }],
      regionId: "v2.ABC",
    });
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://store.vtexcommercestable.com.br");
    expect(url.pathname).toBe("/api/io/_v/api/intelligent-search/product_search/category-1/shirts");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "linen shirt",
      count: "12",
      locale: "pt-BR",
      regionId: "v2.ABC",
      sc: "2",
    });
    expect(header(calls[0], "x-vtex-api-appkey")).toBe("key");
    expect(header(calls[0], "x-vtex-api-apptoken")).toBe("token");
    expect(header(calls[0], "cookie")).toBeNull();
    expect(instrumented.operations).toEqual(["intelligent-search.product_search"]);
  });

  it("names every operation from the VTEX API, never a URL", async () => {
    const { fetch } = upstream();
    const vtex = createVtexClient({ account: "store", fetch });
    await vtex.catalog.pageType("/shirts/linen");
    await vtex.catalog.products({ fq: ["productId:1", "productId:2"], from: 0, to: 9 });
    await vtex.checkout.simulation({ items: [{ id: "1", quantity: 1, seller: "1" }] });
    await vtex.checkout.regions({ postalCode: "01000-000", country: "BRA" });
    await vtex.sessions.get();
    expect(instrumented.operations).toEqual([
      "catalog.pagetype",
      "catalog.products.search",
      "checkout.simulation",
      "checkout.regions",
      "sessions.get",
    ]);
  });

  it("retries an idempotent call and fails fast once the breaker opens", async () => {
    const { calls, fetch } = upstream([503, 200]);
    const vtex = createVtexClient({
      account: "store",
      fetch,
      retry: { attempts: 1, backoffMs: 0 },
    });
    await expect(vtex.catalog.categoryTree()).resolves.toBeDefined();
    expect(calls).toHaveLength(2);

    const down = upstream([500, 500, 500]);
    const failing = createVtexClient({
      account: "store",
      fetch: down.fetch,
      retry: false,
      circuitBreaker: { failures: 2, cooldownMs: 60_000 },
    });
    await expect(failing.catalog.categoryTree()).rejects.toBeInstanceOf(VtexError);
    await expect(failing.catalog.categoryTree()).rejects.toBeInstanceOf(VtexError);
    await expect(failing.catalog.categoryTree()).rejects.toThrow(/circuit open/);
    expect(down.calls).toHaveLength(2);
  });

  it("never retries a cart write", async () => {
    const { calls, fetch } = upstream([503, 200]);
    const vtex = createVtexClient({
      account: "store",
      fetch,
      retry: { attempts: 3, backoffMs: 0 },
    });
    await expect(
      vtex.checkout.addItems("of1", [{ id: 1, quantity: 1, seller: "1" }]),
    ).rejects.toThrow(VtexError);
    expect(calls).toHaveLength(1);
  });

  it("forwards the shopper's cookie, sanitized, and hands back VTEX's Set-Cookie values", async () => {
    const { calls, fetch } = upstream([], {
      "set-cookie": [
        "checkout.vtex.com=__ofid=of1; Domain=store.vtexcommercestable.com.br; Path=/",
      ],
    });
    const vtex = createVtexClient({ account: "store", appKey: "key", appToken: "token", fetch });
    const result = await vtex.checkout.orderForm({
      cookie: "checkout.vtex.com=__ofid=of1; tag=cateçoria",
    });
    expect(header(calls[0], "cookie")).toBe("checkout.vtex.com=__ofid=of1");
    expect(calls[0]?.init.method).toBe("POST");
    // Every orderForm section, and no app credentials next to a shopper's cookie.
    expect(calls[0]?.init.body).toBe("{}");
    expect(header(calls[0], "x-vtex-api-appkey")).toBeNull();
    expect(header(calls[0], "x-vtex-api-apptoken")).toBeNull();
    expect(result.setCookies).toEqual([
      "checkout.vtex.com=__ofid=of1; Domain=store.vtexcommercestable.com.br; Path=/",
    ]);
    expect(result.data).toEqual({ "secret-body": "token-123" });
  });

  it("throws errors that carry the operation and status, never the body, URL or credentials", async () => {
    const { fetch } = upstream([400]);
    const vtex = createVtexClient({
      account: "store",
      appKey: "key",
      appToken: "token-123",
      fetch,
    });
    const error = await vtex.search.products({ query: "q" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VtexError);
    expect(error).toMatchObject({ operation: "intelligent-search.product_search", status: 400 });
    expect((error as Error).message).toBe(
      "vtex intelligent-search.product_search failed with HTTP 400",
    );
  });

  it("narrows the orderForm sections only when asked", async () => {
    const { calls, fetch } = upstream();
    const vtex = createVtexClient({ account: "store", fetch });
    await vtex.checkout.orderForm({ sections: ["items", "totalizers"] });
    expect(calls[0]?.init.body).toBe('{"expectedOrderFormSections":["items","totalizers"]}');
  });

  it("keeps caller paths inside their endpoint", async () => {
    const { calls, fetch } = upstream();
    const vtex = createVtexClient({ account: "store", appKey: "key", appToken: "token", fetch });
    for (const path of [
      "../../api/dataentities/CL/search",
      "/shirts/%2e%2e/%2E%2E/api/dataentities/CL/search",
      "shirts/./linen",
    ]) {
      await expect(vtex.catalog.pageType(path)).rejects.toThrow(/invalid path segment/);
    }
    await expect(vtex.catalog.products({ term: "a/../../../api/x" })).rejects.toThrow(
      /invalid path segment/,
    );
    expect(calls).toHaveLength(0);

    await vtex.catalog.pageType("/shirts/linen?_where=x#y");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(
      "/api/catalog_system/pub/portal/pagetype/shirts/linen%3F_where%3Dx%23y",
    );
    expect(url.search).toBe("");
  });
});
