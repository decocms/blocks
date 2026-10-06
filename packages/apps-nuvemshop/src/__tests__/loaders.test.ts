import type { ProductListingPage } from "@decocms/apps-commerce/types";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import browseFixture from "../__fixtures__/browse-category.json";
import categoriesFixture from "../__fixtures__/categories.json";
import checkoutFixture from "../__fixtures__/checkout.json";
import productFixture from "../__fixtures__/product.json";
import searchFixture from "../__fixtures__/search.json";
import shippingFixture from "../__fixtures__/shipping-options.json";
import createCheckout from "../actions/createCheckout";
import { clearNuvemshopCache, configureNuvemshop, setNuvemshopFetch } from "../client";
import categories from "../loaders/categories";
import productDetailsPage from "../loaders/productDetailsPage";
import productList from "../loaders/productList";
import productListingPage from "../loaders/productListingPage";
import shippingOptions from "../loaders/shippingOptions";
import suggestions from "../loaders/suggestions";

const SITE = "https://loja.example";
const notFound = { error: { code: "resource_not_found", message: "not found" } };
const camisas = categoriesFixture.data.find((c) => c.handle === "camisas")!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Routes requests to the captured fixtures, like the real API would.
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v2026-11\/stores\/8336778/, "");
  if (init?.method === "POST") {
    if (path === "/checkouts") return json(checkoutFixture);
    if (path === "/shipping-options") return json(shippingFixture);
  }
  if (path === "/search/products") return json(searchFixture);
  if (path === "/products") return json(browseFixture);
  if (path === "/products/camisa-xadrez-lenhador-azul") return json(productFixture);
  if (path === "/categories") return json(categoriesFixture);
  if (path === "/categories/camisas" || path === `/categories/${camisas.id}`) return json(camisas);
  return json(notFound, 404);
});
const lastUrl = (pathEnd: string) =>
  new URL(
    String(
      fetchMock.mock.calls
        .map((c) => c[0])
        .reverse()
        .find((u) => new URL(String(u)).pathname.endsWith(pathEnd)),
    ),
  );

beforeEach(() => {
  fetchMock.mockClear();
  clearNuvemshopCache();
  configureNuvemshop({ storeId: "8336778" });
  setNuvemshopFetch(fetchMock as unknown as typeof fetch);
});

describe("productListingPage", () => {
  it("resolves the category from the URL path and returns a PLP", async () => {
    const plp = await productListingPage({
      __pageUrl: `${SITE}/camisas/?Cor=Cinza`,
      __pagePath: "/camisas/",
    });
    expectTypeOf(plp).toEqualTypeOf<ProductListingPage | null>();
    expect(lastUrl("/products").searchParams.get("category_id")).toBe(String(camisas.id));
    expect(lastUrl("/products").searchParams.get("per_page")).toBe("200");
    expect(plp!.products).toHaveLength(1);
    expect(plp!.breadcrumb.itemListElement).toEqual([
      { "@type": "ListItem", name: "Camisas", item: `${SITE}/camisas/`, position: 1 },
    ]);
    expect(plp!.pageInfo.pageTypes).toEqual(["Category"]);
    expect(plp!.seo).toMatchObject({ title: "Camisas", canonical: `${SITE}/camisas/` });
  });

  it("asks the API for best-selling order (the only sort it must do itself)", async () => {
    await productListingPage({ __pageUrl: `${SITE}/camisas/?sort=best-selling` });
    expect(lastUrl("/products").searchParams.get("sort_by")).toBe("best-selling");
    await productListingPage({ __pageUrl: `${SITE}/camisas/?sort=price-ascending` });
    expect(lastUrl("/products").searchParams.has("sort_by")).toBe(false);
  });

  it("searches when there's a term", async () => {
    const plp = await productListingPage({ __pageUrl: `${SITE}/search/?q=vestido` });
    expect(lastUrl("/search/products").searchParams.get("q")).toBe("vestido");
    expect(plp!.products).toHaveLength(searchFixture.data.length);
    expect(plp!.pageInfo.pageTypes).toEqual(["Search"]);
  });

  it("accepts a CMS-pinned categoryId and returns null for unknown categories", async () => {
    expect(
      await productListingPage({ categoryId: camisas.id, __pageUrl: `${SITE}/qualquer/` }),
    ).not.toBeNull();
    expect(await productListingPage({ __pageUrl: `${SITE}/nao-existe/` })).toBeNull();
  });
});

describe("productDetailsPage", () => {
  it("loads by slug and honours ?variant=", async () => {
    const pdp = await productDetailsPage({
      slug: "camisa-xadrez-lenhador-azul",
      __pageUrl: `${SITE}/produtos/camisa-xadrez-lenhador-azul/?variant=1612648511`,
    });
    expect(pdp!.product.productID).toBe("1612648511");
    expect(pdp!.product.url).toBe(
      `${SITE}/produtos/camisa-xadrez-lenhador-azul/?variant=1612648511`,
    );
  });

  it("derives the slug from a /produtos/<handle>/ path and 404s cleanly", async () => {
    const pdp = await productDetailsPage({
      __pageUrl: `${SITE}/produtos/camisa-xadrez-lenhador-azul/`,
    });
    expect(pdp!.product.isVariantOf!.productGroupID).toBe("372190453");
    expect(await productDetailsPage({ slug: "nope" })).toBeNull();
  });
});

describe("productList", () => {
  it("lists by category with an API sort and count", async () => {
    const list = await productList({ categoryId: camisas.id, sort: "price-ascending", count: 2 });
    const url = lastUrl("/products");
    expect(url.searchParams.get("sort_by")).toBe("price-ascending");
    expect(url.searchParams.get("per_page")).toBe("2");
    expect(list.length).toBeGreaterThan(0);
  });

  it("lists by ids/handles without sort_by (the API rejects the combination)", async () => {
    await productList({ ids: [372190453, 372190471], sort: "best-selling" });
    const url = lastUrl("/products");
    expect(url.searchParams.get("ids")).toBe("372190453,372190471");
    expect(url.searchParams.has("sort_by")).toBe(false);
  });

  it("searches by term", async () => {
    await productList({ query: "vestido", count: 4 });
    expect(lastUrl("/search/products").searchParams.get("q")).toBe("vestido");
  });
});

describe("suggestions", () => {
  it("returns products for the term and nothing for a blank one", async () => {
    const s = await suggestions({ query: "vestido", count: 2 });
    expect(s!.products).toHaveLength(2);
    expect(await suggestions({ query: " " })).toBeNull();
  });
});

describe("categories", () => {
  it("builds a navigation tree with nested URLs", async () => {
    const tree = await categories({}, new Request(`${SITE}/`));
    const calcados = tree.find((c) => c.name === "Calçados")!;
    expect(calcados.url).toBe(`${SITE}/calcados/`);
    expect(calcados.children!.map((c) => c.url)).toEqual([
      `${SITE}/calcados/masculino/`,
      `${SITE}/calcados/feminino/`,
    ]);
    expect(tree.some((c) => c.name === "Masculino")).toBe(false);
  });
});

describe("shippingOptions", () => {
  it("quotes one variant for a CEP with numeric prices", async () => {
    const options = await shippingOptions({ zipCode: "01310-100", variantId: 1612648502 });
    expect(options[0]).toMatchObject({ code: "table_default_123123", price: 0 });
  });
});

describe("createCheckout", () => {
  it("maps cart items to line_items and returns the hosted checkout URL", async () => {
    const res = await createCheckout({
      items: [{ productId: 372190453, variantId: 1612648502, quantity: 2 }],
      coupon: " TEST ",
    });
    expect(res.checkoutUrl).toBe(checkoutFixture.checkout_url);
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
    expect(body).toEqual({
      line_items: [{ product_id: 372190453, variant_id: 1612648502, quantity: 2 }],
      coupon_code: "TEST",
    });
  });

  it("rejects an empty cart without calling the API", async () => {
    await expect(createCheckout({ items: [] })).rejects.toThrow(/empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
