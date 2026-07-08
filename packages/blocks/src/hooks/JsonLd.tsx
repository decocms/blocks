/**
 * SEO JSON-LD structured data components.
 *
 * Generates JSON-LD script tags for Product (PDP), ProductList (PLP),
 * and BreadcrumbList schemas. Compatible with Google's Rich Results
 * requirements.
 *
 * @example
 * ```tsx
 * import { ProductJsonLd, PLPJsonLd, BreadcrumbJsonLd } from "@decocms/blocks/hooks";
 *
 * // In a PDP route
 * <ProductJsonLd product={product} />
 *
 * // In a PLP route
 * <PLPJsonLd page={productListingPage} />
 *
 * // Anywhere with breadcrumbs
 * <BreadcrumbJsonLd breadcrumb={breadcrumbList} />
 * ```
 *
 * Type note: originally these components imported `Product`,
 * `ProductListingPage`, `BreadcrumbList`, etc. from apps-start's
 * commerce types module (now `@decocms/apps-commerce/types`).
 * `@decocms/blocks` must not depend on any `apps-*` package (one-way
 * dependency rule: `apps-*` depends on `blocks`, never the reverse), so
 * that import can't carry over as-is. Each function here only reads a
 * small, flat subset of the full schema.org Product/Offer/ListItem
 * graph (the original code already didn't fully trust the nominal
 * `Product.offers` type either — see the `as Offer[] | AggregateOffer`
 * casts it used). The types below are local, minimal, structural
 * equivalents of just that subset: any commerce `Product` /
 * `ProductListingPage` / `BreadcrumbList` value is a structural
 * superset and can be passed in directly without a cast.
 */

// -------------------------------------------------------------------------
// Minimal structural types (see file header for why these aren't imported
// from @decocms/apps-commerce/types)
// -------------------------------------------------------------------------

interface JsonLdOffer {
	price?: number;
	priceCurrency?: string;
	availability?: string;
	seller?: string;
	priceValidUntil?: string;
}

interface JsonLdAggregateOffer {
	"@type"?: string;
	lowPrice?: number;
	priceCurrency?: string;
}

interface JsonLdPriceSpecification {
	priceType?: string;
	price?: number;
}

interface JsonLdAggregateRating {
	ratingValue?: number;
	reviewCount?: number;
	ratingCount?: number;
	bestRating?: number;
	worstRating?: number;
}

interface JsonLdImage {
	url?: string;
}

interface JsonLdBrand {
	name?: string;
}

export interface JsonLdProduct {
	name?: string;
	description?: string;
	url?: string;
	sku?: string;
	productID?: string;
	gtin?: string;
	brand?: JsonLdBrand | null;
	image?: JsonLdImage[] | null;
	offers?: JsonLdOffer[] | JsonLdAggregateOffer;
	aggregateRating?: JsonLdAggregateRating;
}

interface JsonLdSeo {
	canonical?: string;
	title?: string;
	description?: string;
}

export interface JsonLdProductListingPage {
	products?: JsonLdProduct[];
	seo?: JsonLdSeo | null;
}

interface JsonLdListItem {
	position?: number;
	name?: string;
	item?: string;
	url?: string;
}

export interface JsonLdBreadcrumbList {
	itemListElement?: JsonLdListItem[];
}

// -------------------------------------------------------------------------
// JSON-LD script renderer
// -------------------------------------------------------------------------

function JsonLdScript({ data }: { data: unknown }) {
	return (
		<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
	);
}

// -------------------------------------------------------------------------
// Product (PDP)
// -------------------------------------------------------------------------

export interface ProductJsonLdProps {
	product: JsonLdProduct;
	/** Override the canonical URL. Defaults to product.url. */
	url?: string;
}

function getBestOffer(offers: JsonLdOffer[] | JsonLdAggregateOffer | undefined): {
	price?: number;
	priceCurrency?: string;
	availability?: string;
	seller?: string;
	priceValidUntil?: string;
} {
	if (!offers) return {};

	if ("@type" in offers && offers["@type"] === "AggregateOffer") {
		const agg = offers as JsonLdAggregateOffer;
		return {
			price: agg.lowPrice,
			priceCurrency: agg.priceCurrency,
		};
	}

	if (Array.isArray(offers) && offers.length > 0) {
		const best = offers.reduce((a, b) => {
			const ap = a.price ?? Infinity;
			const bp = b.price ?? Infinity;
			return ap <= bp ? a : b;
		});
		return {
			price: best.price,
			priceCurrency: best.priceCurrency,
			availability: best.availability,
			seller: best.seller,
			priceValidUntil: best.priceValidUntil,
		};
	}

	return {};
}

function _getListPrice(priceSpec: JsonLdPriceSpecification[] | undefined): number | undefined {
	if (!priceSpec) return undefined;
	const list = priceSpec.find(
		(p) =>
			p.priceType === "https://schema.org/ListPrice" || p.priceType === "https://schema.org/SRP",
	);
	return list?.price;
}

export function ProductJsonLd({ product, url }: ProductJsonLdProps) {
	const offer = getBestOffer(product.offers);
	const images = product.image?.map((img) => img.url).filter(Boolean) ?? [];
	const rating = product.aggregateRating;

	const data: Record<string, unknown> = {
		"@context": "https://schema.org",
		"@type": "Product",
		name: product.name,
		description: product.description,
		image: images.length === 1 ? images[0] : images,
		url: url ?? product.url,
		sku: product.sku,
		productID: product.productID,
		brand: product.brand ? { "@type": "Brand", name: product.brand.name } : undefined,
		gtin: product.gtin,
	};

	if (offer.price != null) {
		data.offers = {
			"@type": "Offer",
			price: offer.price,
			priceCurrency: offer.priceCurrency ?? "BRL",
			availability: offer.availability ?? "https://schema.org/InStock",
			seller: offer.seller ? { "@type": "Organization", name: offer.seller } : undefined,
			priceValidUntil: offer.priceValidUntil,
			url: url ?? product.url,
		};
	}

	if (rating?.ratingValue) {
		data.aggregateRating = {
			"@type": "AggregateRating",
			ratingValue: rating.ratingValue,
			reviewCount: rating.reviewCount ?? rating.ratingCount ?? 0,
			bestRating: rating.bestRating ?? 5,
			worstRating: rating.worstRating ?? 1,
		};
	}

	return <JsonLdScript data={data} />;
}

// -------------------------------------------------------------------------
// Product Listing Page (PLP)
// -------------------------------------------------------------------------

export interface PLPJsonLdProps {
	page: JsonLdProductListingPage;
	/** Override the canonical URL. */
	url?: string;
}

export function PLPJsonLd({ page, url }: PLPJsonLdProps) {
	const items = (page.products ?? []).map((product, index) => {
		const offer = getBestOffer(product.offers);
		return {
			"@type": "ListItem" as const,
			position: index + 1,
			item: {
				"@type": "Product" as const,
				name: product.name,
				url: product.url,
				image: product.image?.[0]?.url,
				offers:
					offer.price != null
						? {
								"@type": "Offer" as const,
								price: offer.price,
								priceCurrency: offer.priceCurrency ?? "BRL",
								availability: offer.availability ?? "https://schema.org/InStock",
							}
						: undefined,
			},
		};
	});

	const data = {
		"@context": "https://schema.org",
		"@type": "ItemList",
		url: url ?? page.seo?.canonical,
		name: page.seo?.title,
		description: page.seo?.description,
		numberOfItems: page.products?.length ?? 0,
		itemListElement: items,
	};

	return <JsonLdScript data={data} />;
}

// -------------------------------------------------------------------------
// Breadcrumb
// -------------------------------------------------------------------------

export interface BreadcrumbJsonLdProps {
	breadcrumb: JsonLdBreadcrumbList;
}

export function BreadcrumbJsonLd({ breadcrumb }: BreadcrumbJsonLdProps) {
	const items = (breadcrumb.itemListElement ?? []).map((item, index) => {
		return {
			"@type": "ListItem" as const,
			position: item.position ?? index + 1,
			name: item.name,
			item: item.item ?? item.url,
		};
	});

	const data = {
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement: items,
		numberOfItems: items.length,
	};

	return <JsonLdScript data={data} />;
}

// -------------------------------------------------------------------------
// Generic SEO Meta
// -------------------------------------------------------------------------

export interface SeoMetaProps {
	title?: string;
	description?: string;
	canonical?: string;
	image?: string;
	noIndex?: boolean;
	type?: "website" | "article" | "product";
	siteName?: string;
}

/**
 * Generates Open Graph and Twitter Card meta tags.
 *
 * Use this in combination with TanStack Router's `meta()` route option,
 * or render directly in the component tree (tags will be hoisted to <head>
 * by React's built-in behavior with TanStack Start).
 */
export function seoMetaTags(props: SeoMetaProps): Array<Record<string, string>> {
	const tags: Array<Record<string, string>> = [];

	if (props.title) {
		tags.push({ title: props.title });
		tags.push({ property: "og:title", content: props.title });
		tags.push({ name: "twitter:title", content: props.title });
	}

	if (props.description) {
		tags.push({ name: "description", content: props.description });
		tags.push({ property: "og:description", content: props.description });
		tags.push({ name: "twitter:description", content: props.description });
	}

	if (props.canonical) {
		tags.push({ property: "og:url", content: props.canonical });
	}

	if (props.image) {
		tags.push({ property: "og:image", content: props.image });
		tags.push({ name: "twitter:image", content: props.image });
		tags.push({ name: "twitter:card", content: "summary_large_image" });
	}

	if (props.type) {
		tags.push({ property: "og:type", content: props.type });
	}

	if (props.siteName) {
		tags.push({ property: "og:site_name", content: props.siteName });
	}

	if (props.noIndex) {
		tags.push({ name: "robots", content: "noindex, nofollow" });
	}

	return tags;
}
