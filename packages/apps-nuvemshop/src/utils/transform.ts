import type {
  BreadcrumbList,
  ImageObject,
  Product,
  ProductDetailsPage,
  PropertyValue,
  UnitPriceSpecification,
} from "@decocms/apps-commerce/types";
import type { NuvemshopCategory, NuvemshopProduct, NuvemshopVariant } from "./types";

export interface TransformOptions {
  /** Storefront origin used to build absolute URLs. */
  origin: string;
  /** The API carries no currency; it's a store setting. Default "BRL". */
  currency?: string;
}

const IN_STOCK = "https://schema.org/InStock";
const OUT_OF_STOCK = "https://schema.org/OutOfStock";

// Nuvemshop's own URL scheme — kept so migrated stores don't break SEO links.
export const productPath = (handle: string) => `/produtos/${handle}/`;

const money = (v: string | null | undefined) => (v == null || v === "" ? undefined : Number(v));

/** Sale price = promotional_price ?? price; list price = max(compare_at, price). */
export function variantPrices(v: NuvemshopVariant) {
  const base = money(v.price) ?? 0;
  const price = money(v.promotional_price) ?? base;
  const listPrice = Math.max(money(v.compare_at_price) ?? base, base);
  return { price, listPrice };
}

/** `stock: null` means unlimited stock in Nuvemshop. */
export const isAvailable = (v: NuvemshopVariant) =>
  !v.stock_management || v.stock == null || v.stock > 0;

/** `?variant=` id when present, else the first available variant, else the first. */
export function pickVariant(
  product: NuvemshopProduct,
  variantId?: string | null,
): NuvemshopVariant {
  const variants = product.variants ?? [];
  if (!variants.length)
    throw new Error(`Nuvemshop product ${product.id} has no variants (missing "variants" field?)`);
  return (
    (variantId && variants.find((v) => String(v.id) === variantId)) ||
    variants.find(isAvailable) ||
    variants[0]
  );
}

const prop = (name: string, value: string, valueReference: string): PropertyValue => ({
  "@type": "PropertyValue",
  name,
  value,
  valueReference,
});

function toImages(product: NuvemshopProduct, variant?: NuvemshopVariant): ImageObject[] {
  const images = [...(product.images ?? [])];
  const own = images.findIndex((i) => i.id === variant?.image_id);
  if (own > 0) images.unshift(...images.splice(own, 1));
  return images.map((i) => ({
    "@type": "ImageObject",
    url: i.src,
    alternateName: i.alt || product.name,
    encodingFormat: "image",
  }));
}

const stripHtml = (html = "") =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function toProduct(
  product: NuvemshopProduct,
  variant: NuvemshopVariant,
  opts: TransformOptions,
  level = 0,
): Product {
  const { origin, currency = "BRL" } = opts;
  const attributes = product.attributes ?? [];
  const groupUrl = `${origin}${productPath(product.handle)}`;
  const { price, listPrice } = variantPrices(variant);
  const priceSpecification: UnitPriceSpecification[] = [
    {
      "@type": "UnitPriceSpecification",
      priceType: "https://schema.org/ListPrice",
      price: listPrice,
    },
    { "@type": "UnitPriceSpecification", priceType: "https://schema.org/SalePrice", price },
  ];

  return {
    "@type": "Product",
    productID: String(variant.id),
    sku: String(variant.id),
    name: variant.values.join(" / ") || product.name,
    url: `${groupUrl}?variant=${variant.id}`,
    description: product.description,
    gtin: variant.barcode ?? undefined,
    brand: product.brand ? { "@type": "Brand", name: product.brand } : undefined,
    category: product.categories?.map((c) => c.name).join(">") || undefined,
    additionalProperty: variant.values.map((value, i) =>
      prop(attributes[i] ?? `option${i + 1}`, value, "SPECIFICATION"),
    ),
    image: toImages(product, variant),
    video: product.video_url
      ? [
          {
            "@type": "VideoObject",
            contentUrl: product.video_url,
            name: product.name,
            description: product.name,
            uploadDate: "",
            thumbnailUrl: "",
          },
        ]
      : undefined,
    isVariantOf: {
      "@type": "ProductGroup",
      productGroupID: String(product.id),
      name: product.name,
      url: groupUrl,
      model: variant.sku ?? undefined,
      image: toImages(product),
      hasVariant:
        level === 0 ? (product.variants ?? []).map((v) => toProduct(product, v, opts, 1)) : [],
      additionalProperty: [
        ...(product.tags ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => prop("TAG", t, "TAG")),
        ...(product.custom_fields ?? []).map((f) => prop(f.key, f.value, "CUSTOM_FIELD")),
        ...(product.free_shipping ? [prop("freeShipping", "true", "SHIPPING")] : []),
      ],
    },
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: currency,
      lowPrice: price,
      highPrice: listPrice,
      offerCount: 1,
      offers: [
        {
          "@type": "Offer",
          sku: variant.sku ?? undefined,
          gtin: variant.barcode ?? undefined,
          price,
          availability: isAvailable(variant) ? IN_STOCK : OUT_OF_STOCK,
          inventoryLevel: { value: variant.stock ?? undefined },
          priceSpecification,
        },
      ],
    },
  };
}

/** Root→leaf chain of a category, following `parent` ids through `all`. */
export function categoryChain(
  leaf: NuvemshopCategory,
  all: NuvemshopCategory[],
): NuvemshopCategory[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const chain = [leaf];
  for (let c = leaf; c.parent && byId.has(c.parent) && chain.length < 10; ) {
    c = byId.get(c.parent)!;
    chain.unshift(c);
  }
  return chain;
}

export const categoryPath = (chain: NuvemshopCategory[]) =>
  `/${chain.map((c) => c.handle).join("/")}/`;

export function toBreadcrumbList(
  leaf: NuvemshopCategory | undefined,
  all: NuvemshopCategory[],
  origin: string,
  tail: { name: string; url: string }[] = [],
): BreadcrumbList {
  const chain = leaf ? categoryChain(leaf, all) : [];
  const items = [
    ...chain.map((_, i) => ({
      name: chain[i].name,
      url: `${origin}${categoryPath(chain.slice(0, i + 1))}`,
    })),
    ...tail,
  ];
  return {
    "@type": "BreadcrumbList",
    numberOfItems: items.length,
    itemListElement: items.map(({ name, url }, i) => ({
      "@type": "ListItem",
      name,
      item: url,
      position: i + 1,
    })),
  };
}

export function toProductPage(
  product: NuvemshopProduct,
  opts: TransformOptions & { variantId?: string | null },
): ProductDetailsPage {
  const variant = pickVariant(product, opts.variantId);
  const url = `${opts.origin}${productPath(product.handle)}`;
  // The product only carries its category refs; the deepest one wins.
  const refs = (product.categories ?? []).map((c) => ({ ...c, parent: c.parent ?? null }));
  const leaf = [...refs].sort(
    (a, b) => categoryChain(b, refs).length - categoryChain(a, refs).length,
  )[0];
  return {
    "@type": "ProductDetailsPage",
    product: toProduct(product, variant, opts),
    breadcrumbList: toBreadcrumbList(leaf, refs, opts.origin, [{ name: product.name, url }]),
    seo: {
      title: product.seo_title || product.name,
      description: product.seo_description || stripHtml(product.description).slice(0, 160),
      canonical: url,
    },
  };
}
