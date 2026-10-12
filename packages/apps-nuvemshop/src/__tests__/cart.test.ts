import { beforeEach, describe, expect, it, vi } from "vitest";
import browseFixture from "../__fixtures__/browse-category.json";
import { clearNuvemshopCache, configureNuvemshop, setNuvemshopFetch } from "../client";
import cart from "../loaders/cart";

// browse fixture: [0] camisa-xadrez 189.90 (stock 17,20,…), [1] camisa-flanela 169.90 promo / 199.90, [2] camiseta-gamer 89.90
const [xadrez, flanela, gamer] = browseFixture.data;
const SITE = "https://www.loja.example";
const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const ids = (url.searchParams.get("ids") ?? "").split(",").map(Number);
  const data = browseFixture.data.filter((p) => ids.includes(p.id));
  return new Response(
    JSON.stringify({
      data,
      pagination: { page: 1, per_page: 30, total: data.length, total_pages: 1 },
    }),
  );
});
const item = (p: (typeof browseFixture.data)[number], v = 0, quantity = 1) => ({
  productId: p.id,
  variantId: p.variants[v].id,
  quantity,
});

beforeEach(() => {
  fetchMock.mockClear();
  clearNuvemshopCache();
  configureNuvemshop({ storeId: "8336778" });
  setNuvemshopFetch(fetchMock as unknown as typeof fetch);
});

describe("cart loader", () => {
  it("resolves each line from the Storefront API with prices, image and variant", async () => {
    const c = await cart({ items: [item(xadrez, 0, 2), item(flanela, 5)], __pageUrl: `${SITE}/` });
    expect(c.lines).toHaveLength(2);
    expect(c.lines[0]).toMatchObject({
      productId: xadrez.id,
      variantId: xadrez.variants[0].id,
      name: "Camisa Xadrez Lenhador Azul",
      variantName: "P / Azul e Preto",
      quantity: 2,
      maxQuantity: 17,
      price: 189.9,
      listPrice: 189.9,
      subtotal: 379.8,
      url: `${SITE}/produtos/camisa-xadrez-lenhador-azul?variant=${xadrez.variants[0].id}`,
    });
    expect(c.lines[1]).toMatchObject({
      variantName: "M / Cinza",
      price: 169.9,
      listPrice: 199.9,
      subtotal: 169.9,
    });
    expect(c.lines[1].image).toBe(
      flanela.images.find((i) => i.id === flanela.variants[5].image_id)!.src,
    );
    expect(c).toMatchObject({
      itemCount: 3,
      subtotal: 549.7,
      listSubtotal: 579.7,
      savings: 30,
      currency: "BRL",
      unavailable: [],
    });
  });

  it("asks only for the products in the cart (ids, deduped) and nothing for an empty cart", async () => {
    await cart({ items: [item(xadrez, 0), item(xadrez, 1), item(gamer)] });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("ids")).toBe(`${xadrez.id},${gamer.id}`);
    expect(url.searchParams.get("per_page")).toBe("30");

    fetchMock.mockClear();
    expect(await cart({ items: [] })).toMatchObject({ lines: [], itemCount: 0, subtotal: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps quantities to stock (the checkout rejects more) and to 99", async () => {
    const c = await cart({ items: [{ ...item(xadrez, 0), quantity: 50 }] });
    expect(c.lines[0]).toMatchObject({ quantity: 17, maxQuantity: 17, adjusted: true });
  });

  it("moves missing and sold-out variants out of the lines", async () => {
    const soldOut = { ...item(gamer, 0), variantId: gamer.variants[0].id };
    fetchMock.mockImplementationOnce(async () =>
      Response.json({
        data: [
          { ...gamer, variants: gamer.variants.map((v, i) => (i === 0 ? { ...v, stock: 0 } : v)) },
        ],
        pagination: { page: 1, per_page: 30, total: 1, total_pages: 1 },
      }),
    );
    const c = await cart({
      items: [
        soldOut,
        { productId: gamer.id, variantId: 999, quantity: 1 },
        { productId: 1, variantId: 2, quantity: 1 },
      ],
    });
    expect(c.lines).toEqual([]);
    expect(c.unavailable).toEqual([
      { ...soldOut, reason: "out_of_stock" },
      { productId: gamer.id, variantId: 999, quantity: 1, reason: "not_found" },
      { productId: 1, variantId: 2, quantity: 1, reason: "not_found" },
    ]);
  });

  it("fetches in batches of 30 ids (the API limit)", async () => {
    const items = Array.from({ length: 31 }, (_, i) => ({
      productId: i + 1,
      variantId: 1,
      quantity: 1,
    }));
    await cart({ items });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
