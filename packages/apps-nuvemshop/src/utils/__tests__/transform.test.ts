import type { Product, ProductDetailsPage } from "@decocms/apps-commerce/types";
import { describe, expect, expectTypeOf, it } from "vitest";
import browseFixture from "../../__fixtures__/browse-category.json";
import categoriesFixture from "../../__fixtures__/categories.json";
import productFixture from "../../__fixtures__/product.json";
import customFieldsFixture from "../../__fixtures__/product-custom-fields.json";
import { pickVariant, toBreadcrumbList, toProduct, toProductPage } from "../transform";
import type { NuvemshopCategory, NuvemshopList, NuvemshopProduct } from "../types";

// Contract: the captured API responses must satisfy our API types. If the API
// adds/renames a field in a breaking way, these assignments stop compiling.
const raw: NuvemshopProduct = productFixture;
const browse: NuvemshopList<NuvemshopProduct> = browseFixture;
const categories: NuvemshopList<NuvemshopCategory> = categoriesFixture;
const withCustomFields: NuvemshopProduct = customFieldsFixture;

const ORIGIN = "https://loja.example";
const IMG = "https://dcdn-us.mitiendanube.com/stores/008/336/778/products";

describe("toProduct", () => {
  it("maps a variant with no discount to the commerce Product shape", () => {
    const product = toProduct(raw, raw.variants![0], { origin: ORIGIN });
    expectTypeOf(product).toEqualTypeOf<Product>();

    expect(product).toMatchObject({
      "@type": "Product",
      productID: "1612648502",
      sku: "1612648502",
      name: "P / Azul e Preto",
      url: `${ORIGIN}/produtos/camisa-xadrez-lenhador-azul?variant=1612648502`,
      category: "Camisas",
      additionalProperty: [
        { "@type": "PropertyValue", name: "Tamanho", value: "P", valueReference: "SPECIFICATION" },
        {
          "@type": "PropertyValue",
          name: "Cor",
          value: "Azul e Preto",
          valueReference: "SPECIFICATION",
        },
      ],
      image: [
        {
          "@type": "ImageObject",
          url: `${IMG}/1-0dc6e3225f75c6be6617912360695512-1024-1024.webp`,
          alternateName: "Camisa Xadrez Lenhador Azul",
        },
        {
          "@type": "ImageObject",
          url: `${IMG}/2-c444e295855213e1e117912360699859-1024-1024.webp`,
          alternateName: "Camisa Xadrez Lenhador Azul",
        },
      ],
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "BRL",
        lowPrice: 189.9,
        highPrice: 189.9,
        offerCount: 1,
        offers: [
          {
            "@type": "Offer",
            sku: "MD001-1-P",
            price: 189.9,
            availability: "https://schema.org/InStock",
            inventoryLevel: { value: 17 },
            priceSpecification: [
              {
                "@type": "UnitPriceSpecification",
                priceType: "https://schema.org/ListPrice",
                price: 189.9,
              },
              {
                "@type": "UnitPriceSpecification",
                priceType: "https://schema.org/SalePrice",
                price: 189.9,
              },
            ],
          },
        ],
      },
      isVariantOf: {
        "@type": "ProductGroup",
        productGroupID: "372190453",
        name: "Camisa Xadrez Lenhador Azul",
        url: `${ORIGIN}/produtos/camisa-xadrez-lenhador-azul`,
      },
    });
    expect(product.isVariantOf!.hasVariant).toHaveLength(8);
    expect(product.isVariantOf!.hasVariant[4].name).toBe("P / Vermelho e Preto");
  });

  it("uses promotional_price as the sale price and compare_at as the list price", () => {
    const flanela = browse.data[1];
    const product = toProduct(flanela, flanela.variants![0], { origin: ORIGIN });
    expect(product.offers).toMatchObject({ lowPrice: 169.9, highPrice: 199.9 });
    expect(product.offers!.offers[0].price).toBe(169.9);
    expect(product.offers!.offers[0].priceSpecification).toEqual([
      {
        "@type": "UnitPriceSpecification",
        priceType: "https://schema.org/ListPrice",
        price: 199.9,
      },
      {
        "@type": "UnitPriceSpecification",
        priceType: "https://schema.org/SalePrice",
        price: 169.9,
      },
    ]);
  });

  it("puts the variant's own image first", () => {
    const flanela = browse.data[1];
    const cinza = flanela.variants!.find((v) => v.values[1] === "Cinza")!;
    const product = toProduct(flanela, cinza, { origin: ORIGIN });
    expect(product.image![0].url).toBe(flanela.images!.find((i) => i.id === cinza.image_id)!.src);
    expect(product.image).toHaveLength(flanela.images!.length);
  });

  it("derives availability from stock_management/stock (null stock = unlimited)", () => {
    const v = raw.variants![0];
    const at = (patch: Partial<typeof v>) =>
      toProduct(raw, { ...v, ...patch }, { origin: ORIGIN }).offers!.offers[0].availability;
    expect(at({ stock: 0 })).toBe("https://schema.org/OutOfStock");
    expect(at({ stock: null })).toBe("https://schema.org/InStock");
    expect(at({ stock: 0, stock_management: false })).toBe("https://schema.org/InStock");
  });

  it("never leaks the variant cost price", () => {
    const leaky = { ...raw.variants![0], cost: "42.00" };
    expect(
      JSON.stringify(toProduct({ ...raw, variants: [leaky] }, leaky, { origin: ORIGIN })),
    ).not.toContain("42");
  });

  it("exposes brand, gtin and custom fields", () => {
    const product = toProduct(withCustomFields, withCustomFields.variants![0], { origin: ORIGIN });
    expect(product.brand).toEqual({ "@type": "Brand", name: "ACME" });
    expect(product.gtin).toBeUndefined(); // barcode: null upstream
    const v = { ...withCustomFields.variants![0], barcode: "7798446191071" };
    expect(toProduct(withCustomFields, v, { origin: ORIGIN }).gtin).toBe("7798446191071");
    expect(product.isVariantOf!.additionalProperty).toContainEqual({
      "@type": "PropertyValue",
      name: "manual",
      value: "https://files.example.com/manuals/ergonomic-chair-freedom-pt.pdf",
      valueReference: "CUSTOM_FIELD",
    });
  });

  it("flags free shipping (the theme's shipping label) only when the product has it", () => {
    const flag = (free_shipping: boolean) =>
      toProduct({ ...raw, free_shipping }, raw.variants![0], {
        origin: ORIGIN,
      }).isVariantOf!.additionalProperty.filter((p) => p.valueReference === "SHIPPING");
    expect(flag(true)).toEqual([
      { "@type": "PropertyValue", name: "freeShipping", value: "true", valueReference: "SHIPPING" },
    ]);
    expect(flag(false)).toEqual([]);
  });

  it("honours a configured currency", () => {
    expect(
      toProduct(raw, raw.variants![0], { origin: ORIGIN, currency: "ARS" }).offers!.priceCurrency,
    ).toBe("ARS");
  });
});

describe("pickVariant", () => {
  it("selects by ?variant= and falls back to the first available variant", () => {
    const v = raw.variants!;
    expect(pickVariant(raw, "1612648511").id).toBe(1612648511);
    expect(pickVariant(raw, "nope").id).toBe(v[0].id);
    const firstOut = { ...raw, variants: [{ ...v[0], stock: 0 }, v[1]] };
    expect(pickVariant(firstOut).id).toBe(v[1].id);
  });
});

describe("toBreadcrumbList", () => {
  it("walks the category tree from root to leaf", () => {
    const masculino = categories.data.find((c) => c.handle === "masculino")!;
    expect(toBreadcrumbList(masculino, categories.data, ORIGIN)).toEqual({
      "@type": "BreadcrumbList",
      numberOfItems: 2,
      itemListElement: [
        { "@type": "ListItem", name: "Calçados", item: `${ORIGIN}/calcados`, position: 1 },
        {
          "@type": "ListItem",
          name: "Masculino",
          item: `${ORIGIN}/calcados/masculino`,
          position: 2,
        },
      ],
    });
  });
});

describe("toProductPage", () => {
  it("builds a PDP with breadcrumb ending on the product and SEO fallbacks", () => {
    const page = toProductPage(raw, { origin: ORIGIN, variantId: "1612648503" });
    expectTypeOf(page).toEqualTypeOf<ProductDetailsPage>();
    expect(page.product.productID).toBe("1612648503");
    expect(page.breadcrumbList.itemListElement.map((i) => i.name)).toEqual([
      "Camisas",
      "Camisa Xadrez Lenhador Azul",
    ]);
    expect(page.seo).toEqual({
      title: "Camisa Xadrez Lenhador Azul",
      description: expect.stringMatching(/^Camisa xadrez de flanela macia/),
      canonical: `${ORIGIN}/produtos/camisa-xadrez-lenhador-azul`,
    });
    expect(page.seo!.description).not.toMatch(/<\w+/);
  });
});
