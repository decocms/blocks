/**
 * Map a Salesforce Personalization product into a schema.org `Product`
 * suitable for ProductShelf / ProductCard / PDP components.
 *
 * Most fields (id, name, price, images, currency) are common to every
 * Evergage dataset. The `additionalProperty` list, however, is fully
 * dataset-specific — each customer chooses which catalog columns are
 * exposed by Evergage (`Marca`, `Volume`, `Linha`, `freeShipping` etc.).
 * Sites pass a `propertyMapper` to project their custom columns into
 * `schema.org/PropertyValue[]`; the default mapper produces the
 * standard fields that exist on every Evergage product (`itemType`,
 * `categories`).
 */
import type { Offer, Product, PropertyValue } from "@decocms/apps-commerce/types";
import type { SalesforceProduct } from "../types";

const IN_STOCK = "https://schema.org/InStock";
const OUT_OF_STOCK = "https://schema.org/OutOfStock";

export type PropertyMapper = (product: SalesforceProduct) => PropertyValue[];

export interface ProductTransformerOptions {
	/**
	 * Project dataset-specific Evergage columns into schema.org
	 * `PropertyValue[]`. Receives the raw Evergage product (including
	 * any custom fields via the index signature). Returns an empty
	 * array by default — sites that want brand / volume / line tags on
	 * their cards pass a mapper.
	 */
	propertyMapper?: PropertyMapper;
}

const DEFAULT_PROPERTY_MAPPER: PropertyMapper = (product) => {
	const out: PropertyValue[] = [];
	if (product.itemType) {
		out.push({ "@type": "PropertyValue", name: "itemType", value: product.itemType });
	}
	if (product.categories?.length) {
		out.push({
			"@type": "PropertyValue",
			name: "category",
			value: product.categories.join(", "),
		});
	}
	return out;
};

export function toOffer({
	product,
	currencyCode,
}: {
	product: SalesforceProduct;
	currencyCode?: string;
}): Offer[] {
	const productPrice = product.price;
	const productSalePrice = product.salePrice || productPrice;
	return [
		{
			"@type": "Offer",
			availability: product.inventoryCount > 0 ? IN_STOCK : OUT_OF_STOCK,
			inventoryLevel: { value: product.inventoryCount },
			itemCondition: "https://schema.org/NewCondition",
			price: productSalePrice,
			priceCurrency: currencyCode,
			priceSpecification: [
				{
					"@type": "UnitPriceSpecification",
					priceType: "https://schema.org/ListPrice",
					price: productPrice,
				},
				{
					"@type": "UnitPriceSpecification",
					priceType: "https://schema.org/SalePrice",
					price: productSalePrice,
				},
			],
			sku: product.id,
		},
	];
}

export function toImages(product: SalesforceProduct) {
	return product.imageUrls.map((url) => ({
		"@type": "ImageObject" as const,
		encodingFormat: "image",
		alternateName: url,
		url,
	}));
}

/**
 * Returns a `toProduct` function bound to the dataset's property
 * mapper. Sites typically construct one transformer at module level
 * and reuse it across loaders.
 */
export function createProductTransformer(
	options: ProductTransformerOptions = {},
): (input: { product: SalesforceProduct; options: { currencyCode?: string } }) => Product {
	const mapProperties = options.propertyMapper ?? DEFAULT_PROPERTY_MAPPER;

	return ({ product, options: opts }) => {
		const offers = toOffer({ product, currencyCode: opts.currencyCode ?? product.currency });
		const sku = product.id;
		// `idMagento` (cross-system identifier) wins when present —
		// downstream code keys product detail pages off `productID`.
		const productID = (product.idMagento as string | undefined) ?? sku;
		const productPrice = product.price;
		const productSalePrice = product.salePrice || productPrice;
		const productUrl = product.url;
		const additionalProperty = mapProperties(product);

		const variantTemplate: Product = {
			"@type": "Product",
			productID,
			sku,
			url: productUrl,
			name: product.name.trim(),
			gtin: sku,
			offers: {
				"@type": "AggregateOffer",
				highPrice: productPrice,
				lowPrice: productSalePrice,
				offerCount: offers.length,
				offers,
			},
		};

		return {
			"@type": "Product",
			productID,
			sku,
			url: productUrl,
			name: product.name.trim(),
			gtin: sku,
			aggregateRating: { "@type": "AggregateRating", reviewCount: undefined },
			isVariantOf: {
				"@type": "ProductGroup",
				productGroupID: productID,
				url: productUrl,
				name: product.name.trim(),
				model: "",
				additionalProperty,
				hasVariant: [variantTemplate],
			},
			additionalProperty,
			image: toImages(product),
			offers: {
				"@type": "AggregateOffer",
				highPrice: productPrice,
				lowPrice: productSalePrice,
				offerCount: offers.length,
				offers,
			},
		};
	};
}
