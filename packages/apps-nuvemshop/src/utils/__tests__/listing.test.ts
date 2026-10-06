import type { FilterRange, FilterToggle } from "@decocms/apps-commerce/types";
import { describe, expect, it } from "vitest";
import browseFixture from "../../__fixtures__/browse-category.json";
import { applyListing, SORT_OPTIONS } from "../listing";
import type { NuvemshopList, NuvemshopProduct } from "../types";

const browse: NuvemshopList<NuvemshopProduct> = browseFixture;
// camisa-xadrez (189.90, Azul e Preto | Vermelho e Preto), camisa-flanela (169.90 promo, Azul e Preto | Cinza),
// camiseta-gamer (89.90)
const products = browse.data;
const ORIGIN = "https://loja.example";
const run = (qs = "", count = 24) =>
  applyListing(products, new URL(`${ORIGIN}/camisas/${qs}`), { origin: ORIGIN, count });
const toggle = (f: ReturnType<typeof run>["filters"], key: string) =>
  f.find((x): x is FilterToggle => x.key === key && x["@type"] === "FilterToggle")!;

describe("applyListing — facets", () => {
  it("builds one toggle facet per attribute with product counts", () => {
    const cor = toggle(run().filters, "Cor");
    expect(cor.label).toBe("Cor");
    expect(cor.values.map((v) => [v.value, v.quantity, v.selected])).toEqual(
      expect.arrayContaining([
        ["Azul e Preto", 2, false],
        ["Cinza", 1, false],
        ["Vermelho e Preto", 1, false],
      ]),
    );
    expect(cor.values.find((v) => v.value === "Cinza")!.url).toBe(`${ORIGIN}/camisas/?Cor=Cinza`);
  });

  it("filters by attribute (OR within, AND across) and keeps the URL toggle reversible", () => {
    const r = run("?Cor=Cinza");
    expect(r.products.map((p) => p.isVariantOf!.productGroupID)).toEqual(["372190471"]);
    const cinza = toggle(r.filters, "Cor").values.find((v) => v.value === "Cinza")!;
    expect(cinza.selected).toBe(true);
    expect(cinza.url).toBe(`${ORIGIN}/camisas/`);
    // facet counts ignore their own selection
    expect(toggle(r.filters, "Cor").values.find((v) => v.value === "Azul e Preto")!.quantity).toBe(
      2,
    );

    // Nuvemshop theme format: multiple values joined with "|" (OR)
    expect(run("?Cor=Cinza|Vermelho+e+Preto").products).toHaveLength(2);
    expect(run("?Cor=Cinza&Tamanho=P").products).toHaveLength(1);
  });

  it("adds/removes values in the theme's pipe-joined format", () => {
    const cor = (qs: string) => toggle(run(qs).filters, "Cor").values;
    const url = (qs: string, value: string) => decodeURIComponent(cor(qs).find((v) => v.value === value)!.url);
    expect(url("?Cor=Cinza", "Azul e Preto")).toBe(`${ORIGIN}/camisas/?Cor=Cinza|Azul+e+Preto`);
    expect(url("?Cor=Cinza|Azul+e+Preto", "Cinza")).toBe(`${ORIGIN}/camisas/?Cor=Azul+e+Preto`);
    expect(cor("?Cor=Cinza|Azul+e+Preto").filter((v) => v.selected).map((v) => v.value).sort()).toEqual([
      "Azul e Preto",
      "Cinza",
    ]);
  });

  it("shows the card on the variant that matches the selected filter", () => {
    const [card] = run("?Cor=Cinza").products;
    expect(card.additionalProperty!.find((p) => p.name === "Cor")!.value).toBe("Cinza");
  });

  it("offers a price range facet and filters by sale price", () => {
    const price = run().filters.find((f): f is FilterRange => f["@type"] === "FilterRange")!;
    expect(price).toMatchObject({ key: "price", values: { min: 89.9, max: 189.9 } });
    expect(run("?min_price=100&max_price=180").products.map((p) => p.offers!.lowPrice)).toEqual([
      169.9,
    ]);
  });

  it("skips products with no visible variants", () => {
    const hidden = {
      ...products[0],
      variants: products[0].variants!.map((v) => ({ ...v, visible: false })),
    };
    const r = applyListing([hidden, products[2]], new URL(`${ORIGIN}/x`), {
      origin: ORIGIN,
      count: 24,
    });
    expect(r.products).toHaveLength(1);
  });
});

describe("applyListing — sort", () => {
  const ids = (qs: string) => run(qs).products.map((p) => p.offers!.lowPrice);
  it("sorts in memory by price, name and discount; relevance keeps API order", () => {
    expect(ids("")).toEqual([189.9, 169.9, 89.9]);
    expect(ids("?sort=price-ascending")).toEqual([89.9, 169.9, 189.9]);
    expect(ids("?sort=price-descending")).toEqual([189.9, 169.9, 89.9]);
    expect(run("?sort=name-ascending").products.map((p) => p.isVariantOf!.name)).toEqual([
      "Camisa Flanela Montanha",
      "Camisa Xadrez Lenhador Azul",
      "Camiseta Gamer Preta Estampada",
    ]);
    expect(ids("?sort=discount-descending")[0]).toBe(169.9);
  });
  it("lists every sort option with a pt-BR label", () => {
    expect(run().sortOptions).toBe(SORT_OPTIONS);
    expect(SORT_OPTIONS.map((o) => o.value)).toContain("best-selling");
  });
});

describe("applyListing — pagination", () => {
  it("paginates the filtered set and links next/previous preserving filters", () => {
    const p1 = run("?Cor=Azul+e+Preto", 1);
    expect(p1.products).toHaveLength(1);
    expect(p1.pageInfo).toEqual({
      currentPage: 1,
      records: 2,
      recordPerPage: 1,
      nextPage: "?Cor=Azul+e+Preto&page=2",
      previousPage: undefined,
    });
    const p2 = run("?Cor=Azul+e+Preto&page=2", 1);
    expect(p2.pageInfo).toMatchObject({
      currentPage: 2,
      nextPage: undefined,
      previousPage: "?Cor=Azul+e+Preto&page=1",
    });
  });
});
