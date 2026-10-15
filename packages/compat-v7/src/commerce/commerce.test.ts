// @vitest-environment node
/**
 * `@decocms/compat-v7/commerce/*` against v7's own `@decocms/apps-commerce`
 * (`src/__fixtures__/v7/apps-commerce/`, hash-pinned in `__tests__/v7.ts`).
 *
 * 1. Each file is v7's: the two ASTs, printed without comments by the
 *    TypeScript printer, are the same text once v7's extensionless relative
 *    imports get their `.ts` (this repo's rule). Types and code alike, so a
 *    changed field type or a changed expression fails here.
 * 2. Each helper gives v7's output: v7's file runs unchanged (`loadV7`) next
 *    to ours over thousands of generated inputs (seeded, so a failure
 *    reproduces), and every result, thrown error included, is the same.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { v7Loader } from "../__tests__/loadV7";
import { pick, rng } from "../__tests__/v7";
import * as analytics from "./sdk/analytics";
import * as formatPrice from "./sdk/formatPrice";
import * as url from "./sdk/url";
import * as useOffer from "./sdk/useOffer";
import * as variants from "./sdk/useVariantPossibilities";
import * as cart from "./types/cart";
import * as canonical from "./utils/canonical";
import * as constants from "./utils/constants";
import * as filters from "./utils/filters";
import * as productToAnalyticsItem from "./utils/productToAnalyticsItem";
import * as stateByZip from "./utils/stateByZip";

const here = dirname(fileURLToPath(import.meta.url));
const v7Dir = join(here, "../__fixtures__/v7/apps-commerce");
const v7 = v7Loader();
const load = (file: string) => v7(`apps-commerce/${file}`);

const FILES = readdirSync(here, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort();

function printed(text: string, file: string): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

describe("each /commerce file is v7's apps-commerce file", () => {
  it("covers v7's pure files, and only those", () => {
    const v7Files = readdirSync(v7Dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(FILES).toEqual(v7Files);
  });

  it.each(FILES)("%s: same code and types (comments and formatting aside)", (file) => {
    const ours = readFileSync(join(here, file), "utf8");
    const theirs = readFileSync(join(v7Dir, file), "utf8").replace(
      /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
      "$1$2.ts$3",
    );
    expect(printed(ours, file)).toBe(printed(theirs, file));
  });

  it("is React-free and imports only its own files", () => {
    for (const file of FILES) {
      const text = readFileSync(join(here, file), "utf8");
      for (const [, spec] of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        expect([relative(here, join(here, file)), spec]).toEqual([
          relative(here, join(here, file)),
          expect.stringMatching(/^\.\.?\/.*\.ts$/),
        ]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Generated inputs.
// ---------------------------------------------------------------------------

type R = () => number;

/** Calls `fn` and records its result or the error it threw, so the two sides compare. */
function outcome(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (error) {
    return { threw: String(error) };
  }
}

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.1,
  0.005,
  1.005,
  9.99,
  10,
  99.995,
  1234.5,
  1e6,
  1e21,
  -42.42,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
];
const num = (r: R): number => (r() < 0.5 ? pick(r, NUMBERS) : Math.round(r() * 1e7) / 100);
const maybe = <T>(r: R, value: () => T, p = 0.7): T | undefined => (r() < p ? value() : undefined);
const WORDS = ["Camiseta", "Tênis", "Azul", "P", "M", "GG", "38", "Algodão", "", " x ", "Ação"];
const word = (r: R) => pick(r, WORDS);

function priceSpec(r: R) {
  return {
    "@type": "UnitPriceSpecification" as const,
    priceType: pick(r, [
      "https://schema.org/ListPrice",
      "https://schema.org/SalePrice",
      "https://schema.org/SRP",
      "https://schema.org/InvoicePrice",
    ]),
    priceComponentType: maybe(r, () =>
      pick(r, ["https://schema.org/Installment", "https://schema.org/Tax"]),
    ),
    price: num(r),
    billingDuration: maybe(r, () => pick(r, [0, 1, 2, 3, 6, 10, 12])),
    billingIncrement: maybe(r, () => num(r)),
    name: maybe(r, () => word(r)),
  };
}

function offer(r: R) {
  return {
    "@type": "Offer" as const,
    price: maybe(r, () => num(r), 0.9),
    availability: pick(r, ["https://schema.org/InStock", "https://schema.org/OutOfStock"]),
    seller: maybe(r, () => pick(r, ["1", "seller-2", ""])),
    priceSpecification: maybe(
      r,
      () => Array.from({ length: Math.floor(r() * 6) }, () => priceSpec(r)),
      0.9,
    ),
    inventoryLevel: { value: Math.floor(r() * 10) },
  };
}

function aggregateOffer(r: R) {
  return {
    "@type": "AggregateOffer" as const,
    highPrice: num(r),
    lowPrice: num(r),
    offerCount: 1,
    offers: maybe(r, () => Array.from({ length: Math.floor(r() * 3) }, () => offer(r)), 0.9),
  };
}

const PROPS = ["Tamanho", "Cor", "Voltagem", "category", "cluster", "RefId", "descriptionHtml"];

function leaf(r: R, id: number) {
  return {
    "@type": "Product" as const,
    productID: String(id),
    sku: String(id),
    url: maybe(r, () => `/produto-${id}/p?skuId=${id}`, 0.9),
    name: maybe(r, () => word(r)),
    additionalProperty: maybe(
      r,
      () =>
        Array.from({ length: Math.floor(r() * 4) }, () => ({
          "@type": "PropertyValue" as const,
          name: pick(r, PROPS),
          value: word(r),
        })),
      0.9,
    ),
  };
}

function breadcrumb(r: R) {
  return {
    "@type": "BreadcrumbList" as const,
    numberOfItems: 0,
    itemListElement: Array.from({ length: Math.floor(r() * 7) }, (_, i) => ({
      "@type": "ListItem" as const,
      name: maybe(r, () => word(r), 0.85),
      item: `https://loja.example/${i}`,
      position: pick(r, [i, i + 1, 7 - i, 3]),
    })),
  };
}

function product(r: R) {
  const id = Math.floor(r() * 1000);
  return {
    ...leaf(r, id),
    inProductGroupWithID: maybe(r, () => String(id + 1)),
    category: maybe(r, () =>
      Array.from({ length: Math.floor(r() * 7) }, () => word(r)).join(pick(r, [">", " > ", ">>"])),
    ),
    brand: maybe(r, () => ({ "@type": "Brand" as const, name: maybe(r, () => word(r)) })),
    isVariantOf: maybe(r, () => ({
      "@type": "ProductGroup" as const,
      productGroupID: String(id + 2),
      name: maybe(r, () => word(r)),
      hasVariant: [],
      additionalProperty: [],
      url: "/",
    })),
    offers: maybe(r, () => aggregateOffer(r)),
  };
}

/** The fuzz runs take seconds; a busy machine (the whole suite in parallel) needs room. */
const FUZZ = { timeout: 120_000 };

const CASES = 5_000;

function fuzz(name: string, seed: number, run: (r: R) => [unknown, unknown]) {
  it(`${name}: ${CASES} generated inputs`, FUZZ, () => {
    const r = rng(seed);
    for (let i = 0; i < CASES; i++) {
      const [ours, theirs] = run(r);
      expect([i, ours]).toEqual([i, theirs]);
    }
  });
}

describe("each helper gives v7's output", () => {
  const v7Price = load("sdk/formatPrice.ts");
  const CURRENCIES = ["BRL", "USD", "EUR", "JPY", "CLP", "brl", "XYZ", ""];
  const LOCALES = ["pt-BR", "en-US", "de-DE", "ja-JP", "es-CL", "fr"];

  fuzz("formatPrice", 1, (r) => {
    const args = [
      pick(r, [...NUMBERS, null, undefined, 12.5, 1999.9]),
      maybe(r, () => pick(r, CURRENCIES)),
      maybe(r, () => pick(r, LOCALES)),
    ] as const;
    return [
      outcome(() => formatPrice.formatPrice(...args)),
      outcome(() => v7Price.formatPrice(...args)),
    ];
  });

  fuzz("formatPriceRange", 2, (r) => {
    const n = () => pick(r, ["10", "0", "-5", "1.5", "abc", "", "1e3", " 7 ", "Infinity"]);
    const value = pick(r, [
      `${n()}:${n()}`,
      `${n()}:${n()}:${n()}`,
      n(),
      ":",
      "10:",
      42 as unknown as string,
    ]);
    const args = [
      value,
      maybe(r, () => pick(r, CURRENCIES)),
      maybe(r, () => pick(r, LOCALES)),
      maybe(r, () => pick(r, [" - ", " a ", "–"])),
    ] as const;
    return [
      outcome(() => formatPrice.formatPriceRange(...args)),
      outcome(() => v7Price.formatPriceRange(...args)),
    ];
  });

  const v7Url = load("sdk/url.ts");
  fuzz("relative", 3, (r) => {
    const link = pick(r, [
      undefined,
      "",
      "/p/foo",
      "https://x.com/p/foo?a=1&idsku=2",
      "/p/foo?idsku=1&keep=2&skuId=3",
      "p/bar?x=%20y#frag",
      "http://[::1",
      "//cdn.example/a?b=c",
      "/a b/ç?q=a+b&q=c",
      "?only=query",
      "https://loja.example:8080/path/?",
    ]);
    const options = maybe(r, () => ({
      stripSearchParams: maybe(r, () =>
        Array.from({ length: Math.floor(r() * 3) }, () => pick(r, ["idsku", "skuId", "a", "q"])),
      ),
    }));
    return [
      outcome(() => url.relative(link, options)),
      outcome(() => v7Url.relative(link, options)),
    ];
  });

  const v7Offer = load("sdk/useOffer.ts");
  fuzz("useOffer", 4, (r) => {
    const input = maybe(r, () => aggregateOffer(r), 0.95);
    return [
      outcome(() => useOffer.useOffer(input as never)),
      outcome(() => v7Offer.useOffer(input)),
    ];
  });

  fuzz("bestInstallment", 5, (r) => {
    const specs = Array.from({ length: 1 + Math.floor(r() * 6) }, () => priceSpec(r));
    return [
      outcome(() => (specs as never[]).reduce(useOffer.bestInstallment, null)),
      outcome(() => specs.reduce(v7Offer.bestInstallment, null)),
    ];
  });

  const v7Variants = load("sdk/useVariantPossibilities.ts");
  fuzz("useVariantPossibilities", 6, (r) => {
    const list = Array.from({ length: Math.floor(r() * 8) }, (_, i) => leaf(r, i));
    const selected = list.length && r() < 0.8 ? pick(r, list) : leaf(r, 99);
    return [
      outcome(() => variants.useVariantPossibilities(list as never, selected as never)),
      outcome(() => v7Variants.useVariantPossibilities(list, selected)),
    ];
  });

  const v7Analytics = load("sdk/analytics.ts");
  fuzz("sdk/analytics mapProductToAnalyticsItem", 7, (r) => {
    const opts = {
      product: product(r),
      breadcrumbList: maybe(r, () => breadcrumb(r), 0.5),
      price: maybe(r, () => num(r)),
      lowPrice: maybe(r, () => num(r)),
      listPrice: maybe(r, () => num(r)),
      index: maybe(r, () => Math.floor(r() * 20)),
      quantity: maybe(r, () => Math.floor(r() * 5)),
      coupon: maybe(r, () => word(r)),
      extend: maybe(
        r,
        () => (p: { sku?: string }, base: { price?: number }) => ({
          sellerP: p.sku,
          doubled: (base.price ?? 0) * 2,
        }),
        0.3,
      ),
    };
    return [
      outcome(() => analytics.mapProductToAnalyticsItem(opts as never)),
      outcome(() => v7Analytics.mapProductToAnalyticsItem(opts)),
    ];
  });

  fuzz("sdk/analytics mapProductToAnalyticsItemList", 8, (r) => {
    const opts = {
      product: product(r),
      breadcrumbList: maybe(r, () => breadcrumb(r), 0.5),
      price: maybe(r, () => num(r)),
      listPrice: maybe(r, () => num(r)),
      index: maybe(r, () => Math.floor(r() * 20)),
      quantity: maybe(r, () => Math.floor(r() * 5)),
      coupon: maybe(r, () => word(r)),
    };
    return [
      outcome(() => analytics.mapProductToAnalyticsItemList(opts as never)),
      outcome(() => v7Analytics.mapProductToAnalyticsItemList(opts)),
    ];
  });

  const v7Item = load("utils/productToAnalyticsItem.ts");
  fuzz("utils/productToAnalyticsItem mapProductToAnalyticsItem", 9, (r) => {
    const opts = {
      product: product(r),
      breadcrumbList: maybe(r, () => breadcrumb(r), 0.5),
      price: maybe(r, () => num(r)),
      listPrice: maybe(r, () => num(r)),
      index: maybe(r, () => Math.floor(r() * 20)),
      quantity: maybe(r, () => Math.floor(r() * 5)),
      coupon: maybe(r, () => word(r)),
    };
    return [
      outcome(() => productToAnalyticsItem.mapProductToAnalyticsItem(opts as never)),
      outcome(() => v7Item.mapProductToAnalyticsItem(opts)),
    ];
  });

  fuzz("category mappers (sdk/analytics and utils/productToAnalyticsItem)", 10, (r) => {
    const list = Array.from({ length: Math.floor(r() * 8) }, () => word(r));
    const path = list.join(pick(r, [">", " > "]));
    return [
      [
        analytics.mapCategoriesToAnalyticsCategories(list),
        analytics.mapProductCategoryToAnalyticsCategories(path),
        productToAnalyticsItem.mapCategoriesToAnalyticsCategories(list),
        productToAnalyticsItem.mapProductCategoryToAnalyticsCategories(path),
      ],
      [
        v7Analytics.mapCategoriesToAnalyticsCategories(list),
        v7Analytics.mapProductCategoryToAnalyticsCategories(path),
        v7Item.mapCategoriesToAnalyticsCategories(list),
        v7Item.mapProductCategoryToAnalyticsCategories(path),
      ],
    ];
  });

  const v7Filters = load("utils/filters.ts");
  fuzz("parseRange and formatRange", 11, (r) => {
    const part = () => pick(r, ["10", "0", "-1", "2.5", "x", "", " 3", "1e2", "NaN"]);
    const input = pick(r, [`${part()}:${part()}`, part(), `${part()}:${part()}:${part()}`]);
    const a = num(r);
    const b = num(r);
    return [
      [outcome(() => filters.parseRange(input)), filters.formatRange(a, b)],
      [outcome(() => v7Filters.parseRange(input)), v7Filters.formatRange(a, b)],
    ];
  });

  const v7Canonical = load("utils/canonical.ts");
  fuzz("canonicalFromBreadcrumblist", 12, (r) => {
    const input = pick(r, [undefined, breadcrumb(r), { itemListElement: "x" }, {}]);
    return [
      outcome(() => canonical.canonicalFromBreadcrumblist(input as never)),
      outcome(() => v7Canonical.canonicalFromBreadcrumblist(input)),
    ];
  });

  const v7Zip = load("utils/stateByZip.ts");
  fuzz("getStateFromZip", 13, (r) => {
    const digits = String(Math.floor(r() * 100_000_000)).padStart(8, "0");
    const zip = pick(r, [
      digits,
      `${digits.slice(0, 5)}-${digits.slice(5)}`,
      digits.slice(0, 5),
      "abc",
      "",
      ` ${digits} `,
    ]);
    return [stateByZip.default(zip), v7Zip.default(zip)];
  });

  it("constants and cart presets", () => {
    const v7Cart = load("types/cart.ts");
    const v7Constants = load("utils/constants.ts");
    expect(constants.DEFAULT_IMAGE).toEqual(v7Constants.DEFAULT_IMAGE);
    expect([cart.SECTIONS_MINIMAL, cart.SECTIONS_DRAWER, cart.SECTIONS_FULL]).toEqual([
      v7Cart.SECTIONS_MINIMAL,
      v7Cart.SECTIONS_DRAWER,
      v7Cart.SECTIONS_FULL,
    ]);
    for (const projection of ["none", "summary", "summary+items", "minicart", "raw", "x"]) {
      expect(cart.defaultSectionsFor(projection as never)).toEqual(
        v7Cart.defaultSectionsFor(projection),
      );
    }
    // Every value export of every file is compared above or by a fuzz case.
    const values = (mod: object) => Object.keys(mod).sort();
    expect(values(cart)).toEqual(values(v7Cart));
    expect(values(useOffer)).toEqual(values(v7Offer));
    expect(values(analytics)).toEqual(values(v7Analytics));
    expect(values(formatPrice)).toEqual(values(v7Price));
  });
});
