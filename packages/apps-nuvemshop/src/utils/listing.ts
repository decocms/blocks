/**
 * In-memory PLP: facets, sort and pagination over a window of products.
 *
 * The Storefront API (v2026-11) has no facets and only three sorts, while the
 * Nuvemshop core already filters by variant values and price. Until the API
 * exposes those, we fetch a window of products and compute everything here.
 * URL params mirror the core theme (`?Cor=Vermelho|Preto&min_price=100`, values
 * OR-ed with "|") so links keep working after a migration.
 *
 * ponytail: correct only while the category/search fits in one API page
 * (≤200 products, `LISTING_WINDOW`). Switch to native API facets when they ship.
 */
import type { Filter, PageInfo, Product, SortOption } from "@decocms/apps-commerce/types";
import { isAvailable, type TransformOptions, toProduct, variantPrices } from "./transform";
import type { NuvemshopProduct, NuvemshopVariant } from "./types";

export const LISTING_WINDOW = 200;

export const SORT_OPTIONS: SortOption[] = [
  { value: "relevance", label: "Relevância" },
  { value: "best-selling", label: "Mais vendidos" },
  { value: "created-descending", label: "Lançamentos" },
  { value: "price-ascending", label: "Menor preço" },
  { value: "price-descending", label: "Maior preço" },
  { value: "discount-descending", label: "Maior desconto" },
  { value: "name-ascending", label: "A - Z" },
  { value: "name-descending", label: "Z - A" },
];

type Selection = Map<string, Set<string>>;

/** The theme joins multiple values of one filter with "|" (`?Cor=Vermelho|Preto`). */
const VALUE_SEPARATOR = "|";
const valuesOf = (params: URLSearchParams, attr: string) =>
  (params.get(attr) ?? "").split(VALUE_SEPARATOR).filter(Boolean);

const visibleVariants = (p: NuvemshopProduct) =>
  (p.variants ?? []).filter((v) => v.visible !== false);
const minPrice = (p: NuvemshopProduct) =>
  Math.min(...visibleVariants(p).map((v) => variantPrices(v).price));
const maxDiscount = (p: NuvemshopProduct) =>
  Math.max(
    ...visibleVariants(p).map((v) => {
      const { price, listPrice } = variantPrices(v);
      return listPrice ? (listPrice - price) / listPrice : 0;
    }),
  );

function variantMatches(p: NuvemshopProduct, v: NuvemshopVariant, sel: Selection, skip?: string) {
  const attrs = p.attributes ?? [];
  for (const [attr, values] of sel) {
    if (attr === skip) continue;
    const i = attrs.indexOf(attr);
    if (i < 0 || !values.has(v.values[i])) return false;
  }
  return true;
}

const matchingVariants = (p: NuvemshopProduct, sel: Selection, skip?: string) =>
  visibleVariants(p).filter((v) => variantMatches(p, v, sel, skip));

const sorters: Record<string, (a: NuvemshopProduct, b: NuvemshopProduct) => number> = {
  "price-ascending": (a, b) => minPrice(a) - minPrice(b),
  "price-descending": (a, b) => minPrice(b) - minPrice(a),
  "discount-descending": (a, b) => maxDiscount(b) - maxDiscount(a),
  "name-ascending": (a, b) => a.name.localeCompare(b.name),
  "name-descending": (a, b) => b.name.localeCompare(a.name),
  "created-descending": (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""),
};

function withParams(url: URL, mutate: (p: URLSearchParams) => void) {
  const next = new URL(url);
  next.searchParams.delete("page");
  mutate(next.searchParams);
  return next.toString();
}

export interface ListingOptions extends TransformOptions {
  /** Products per page. */
  count: number;
}

export function applyListing(source: NuvemshopProduct[], url: URL, opts: ListingOptions) {
  const products = source.filter((p) => visibleVariants(p).length > 0);
  const attributes = [...new Set(products.flatMap((p) => p.attributes ?? []))];

  const sel: Selection = new Map();
  for (const attr of attributes) {
    const values = valuesOf(url.searchParams, attr);
    if (values.length) sel.set(attr, new Set(values));
  }
  const lo = Number(url.searchParams.get("min_price") ?? Number.NEGATIVE_INFINITY);
  const hi = Number(url.searchParams.get("max_price") ?? Number.POSITIVE_INFINITY);
  const inPrice = (p: NuvemshopProduct) => minPrice(p) >= lo && minPrice(p) <= hi;

  const filtered = products.filter((p) => inPrice(p) && matchingVariants(p, sel).length > 0);
  const sorter = sorters[url.searchParams.get("sort") ?? ""];
  if (sorter) filtered.sort(sorter);

  // Facet counts ignore their own attribute's selection (standard facet UX).
  const filters: Filter[] = attributes.map((attr) => {
    const counts = new Map<string, number>();
    for (const p of products) {
      if (!inPrice(p)) continue;
      const i = (p.attributes ?? []).indexOf(attr);
      if (i < 0) continue;
      for (const value of new Set(matchingVariants(p, sel, attr).map((v) => v.values[i]))) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const selected = sel.get(attr) ?? new Set<string>();
    return {
      "@type": "FilterToggle",
      key: attr,
      label: attr,
      quantity: counts.size,
      values: [...counts].map(([value, quantity]) => ({
        value,
        label: value,
        quantity,
        selected: selected.has(value),
        url: withParams(url, (p) => {
          const rest = valuesOf(p, attr).filter((v) => v !== value);
          const next = selected.has(value) ? rest : [...rest, value];
          if (next.length) p.set(attr, next.join(VALUE_SEPARATOR));
          else p.delete(attr);
        }),
      })),
    };
  });
  if (products.length) {
    const prices = products.map(minPrice);
    filters.push({
      "@type": "FilterRange",
      key: "price",
      label: "Preço",
      values: { min: Math.min(...prices), max: Math.max(...prices) },
    });
  }

  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const start = (page - 1) * opts.count;
  const pageLink = (n: number) => {
    const p = new URLSearchParams(url.search);
    p.set("page", String(n));
    return `?${p}`;
  };
  const pageInfo: PageInfo = {
    currentPage: page,
    records: filtered.length,
    recordPerPage: opts.count,
    nextPage: start + opts.count < filtered.length ? pageLink(page + 1) : undefined,
    previousPage: page > 1 ? pageLink(page - 1) : undefined,
  };

  return {
    products: filtered.slice(start, start + opts.count).map((p): Product => {
      const matches = matchingVariants(p, sel);
      return toProduct(p, matches.find(isAvailable) ?? matches[0], opts);
    }),
    filters,
    pageInfo,
    sortOptions: SORT_OPTIONS,
  };
}
