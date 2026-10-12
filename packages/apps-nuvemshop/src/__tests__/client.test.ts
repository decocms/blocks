import { beforeEach, describe, expect, it, vi } from "vitest";
import productFixture from "../__fixtures__/product.json";
import {
  CATEGORY_FIELDS,
  clearNuvemshopCache,
  configureNuvemshop,
  nuvemshopGet,
  nuvemshopPost,
  PRODUCT_FIELDS,
  setNuvemshopFetch,
} from "../client";

const API = "https://storefront-api.tiendanube.com/v2026-11/stores/8336778";

function mockFetch(body: unknown = productFixture, status = 200) {
  const fn = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  setNuvemshopFetch(fn as unknown as typeof fetch);
  return fn;
}
const call = (fn: ReturnType<typeof mockFetch>, i = 0) => ({
  url: new URL(String(fn.mock.calls[i][0])),
  headers: new Headers(fn.mock.calls[i][1]?.headers),
  init: fn.mock.calls[i][1],
});

beforeEach(() => {
  clearNuvemshopCache();
  configureNuvemshop({ storeId: "8336778" });
});

describe("nuvemshopGet", () => {
  it("targets the versioned store URL and passes params through", async () => {
    const fn = mockFetch();
    await nuvemshopGet("/products", { category_id: 41376194, page: 2, ids: undefined });
    const { url } = call(fn);
    expect(`${url.origin}${url.pathname}`).toBe(`${API}/products`);
    expect(url.searchParams.get("category_id")).toBe("41376194");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("ids")).toBe(false);
  });

  it("always asks for the full product field set on product routes", async () => {
    const fn = mockFetch();
    await nuvemshopGet("/products/camisa");
    await nuvemshopGet("/search/products", { q: "x" });
    expect(call(fn, 0).url.searchParams.get("fields")).toBe(PRODUCT_FIELDS);
    expect(call(fn, 1).url.searchParams.get("fields")).toBe(PRODUCT_FIELDS);
    expect(PRODUCT_FIELDS.split(",")).toEqual(
      expect.arrayContaining(["variants", "images", "attributes"]),
    );
    expect(PRODUCT_FIELDS).not.toContain("cost");
  });

  it("asks for parent/subcategories on category routes (the default selection omits them)", async () => {
    const fn = mockFetch();
    await nuvemshopGet("/categories", { per_page: 200 });
    await nuvemshopGet("/categories/calcados");
    for (const i of [0, 1]) {
      expect(call(fn, i).url.searchParams.get("fields")).toBe(CATEGORY_FIELDS);
    }
    expect(CATEGORY_FIELDS.split(",")).toEqual(expect.arrayContaining(["parent", "subcategories"]));
  });

  it("is tokenless by default and sends a bearer token when configured", async () => {
    const fn = mockFetch();
    await nuvemshopGet("/categories");
    expect(call(fn).headers.has("authorization")).toBe(false);

    configureNuvemshop({ storeId: "8336778", token: "secret" });
    await nuvemshopGet("/categories", { page: 2 }); // same URL would be a cache hit
    expect(call(fn, 1).headers.get("authorization")).toBe("Bearer secret");
    expect(call(fn, 1).headers.has("x-linkedstore-buyer-ip")).toBe(false);
  });

  it("dedups identical GETs through the SWR cache", async () => {
    const fn = mockFetch();
    await Promise.all([nuvemshopGet("/products/a"), nuvemshopGet("/products/a")]);
    await nuvemshopGet("/products/a");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns null on 404", async () => {
    mockFetch({ error: { code: "resource_not_found", message: "nope" } }, 404);
    expect(await nuvemshopGet("/products/missing")).toBeNull();
  });

  it("throws when not configured", async () => {
    configureNuvemshop(null);
    await expect(nuvemshopGet("/products")).rejects.toThrow(/not configured/);
  });
});

describe("nuvemshopPost", () => {
  it("posts JSON and forwards the buyer IP only with a token", async () => {
    const fn = mockFetch({ checkout_url: "https://x" });
    await nuvemshopPost("/checkouts", { line_items: [] }, { buyerIp: "203.0.113.10" });
    expect(call(fn).init?.method).toBe("POST");
    expect(call(fn).headers.has("x-linkedstore-buyer-ip")).toBe(false);

    configureNuvemshop({ storeId: "8336778", token: "secret" });
    await nuvemshopPost("/checkouts", { line_items: [] }, { buyerIp: "203.0.113.10" });
    expect(call(fn, 1).headers.get("x-linkedstore-buyer-ip")).toBe("203.0.113.10");
    expect(JSON.parse(String(call(fn, 1).init?.body))).toEqual({ line_items: [] });
  });

  it("surfaces the API error message", async () => {
    mockFetch({ error: { code: "invalid_body", message: "The request body is invalid." } }, 400);
    await expect(nuvemshopPost("/checkouts", {})).rejects.toThrow(
      /invalid_body.*The request body is invalid/,
    );
  });
});
