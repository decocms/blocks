/**
 * Tests for utils/transform.ts.
 *
 * The Salesforce transformer is the only spot in the upstream package
 * where consumer-specific behavior (the dataset's custom column shape)
 * shows through, via the `propertyMapper` hook. The tests here lock:
 *
 *  - default mapper outputs the always-present Evergage columns
 *    (itemType, categories) without dragging in dataset-specific
 *    fields,
 *  - a custom propertyMapper sees the raw Evergage product (including
 *    custom columns via the index signature),
 *  - schema.org shape is stable (productID precedence, AggregateOffer
 *    surface, isVariantOf hasVariant).
 *
 * These match the regressions the legacy `apps/salesforce/utils/
 * transform.ts` watched for over its lifetime.
 */
import { describe, expect, it } from "vitest";
import type { SalesforceProduct } from "../types";
import {
	createProductTransformer,
	type PropertyMapper,
	toImages,
	toOffer,
} from "../utils/transform";

const baseProduct = (overrides: Partial<SalesforceProduct> = {}): SalesforceProduct => ({
	id: "SKU-42",
	name: "Test Product",
	price: 100,
	salePrice: 80,
	inventoryCount: 7,
	imageUrls: ["https://cdn.example.com/p/42.jpg"],
	url: "https://loja.example.com/p/test",
	currency: "BRL",
	itemType: "simple",
	categories: ["category-a", "category-b"],
	...overrides,
});

describe("toOffer", () => {
	it("emits InStock when inventoryCount > 0", () => {
		const [offer] = toOffer({ product: baseProduct(), currencyCode: "BRL" });
		expect(offer.availability).toBe("https://schema.org/InStock");
		expect(offer.inventoryLevel?.value).toBe(7);
	});

	it("emits OutOfStock when inventoryCount is 0", () => {
		const [offer] = toOffer({
			product: baseProduct({ inventoryCount: 0 }),
			currencyCode: "BRL",
		});
		expect(offer.availability).toBe("https://schema.org/OutOfStock");
	});

	it("falls back to price when salePrice is missing", () => {
		const [offer] = toOffer({
			product: baseProduct({ salePrice: undefined }),
			currencyCode: "BRL",
		});
		expect(offer.price).toBe(100);
	});

	it("uses salePrice as the primary price when present", () => {
		const [offer] = toOffer({ product: baseProduct(), currencyCode: "BRL" });
		expect(offer.price).toBe(80);
	});

	it("threads currencyCode into priceCurrency", () => {
		const [offer] = toOffer({ product: baseProduct(), currencyCode: "USD" });
		expect(offer.priceCurrency).toBe("USD");
	});

	it("emits ListPrice + SalePrice priceSpecification entries", () => {
		const [offer] = toOffer({ product: baseProduct(), currencyCode: "BRL" });
		expect(offer.priceSpecification).toEqual([
			{
				"@type": "UnitPriceSpecification",
				priceType: "https://schema.org/ListPrice",
				price: 100,
			},
			{
				"@type": "UnitPriceSpecification",
				priceType: "https://schema.org/SalePrice",
				price: 80,
			},
		]);
	});
});

describe("toImages", () => {
	it("maps each imageUrl to a schema.org ImageObject", () => {
		const images = toImages(
			baseProduct({
				imageUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
			}),
		);
		expect(images).toEqual([
			{
				"@type": "ImageObject",
				encodingFormat: "image",
				alternateName: "https://cdn.example.com/a.jpg",
				url: "https://cdn.example.com/a.jpg",
			},
			{
				"@type": "ImageObject",
				encodingFormat: "image",
				alternateName: "https://cdn.example.com/b.jpg",
				url: "https://cdn.example.com/b.jpg",
			},
		]);
	});

	it("returns an empty array when imageUrls is empty", () => {
		expect(toImages(baseProduct({ imageUrls: [] }))).toEqual([]);
	});
});

describe("createProductTransformer", () => {
	it("uses default mapper when no propertyMapper is passed", () => {
		const transform = createProductTransformer();
		const out = transform({ product: baseProduct(), options: { currencyCode: "BRL" } });
		expect(out.additionalProperty).toEqual([
			{ "@type": "PropertyValue", name: "itemType", value: "simple" },
			{ "@type": "PropertyValue", name: "category", value: "category-a, category-b" },
		]);
	});

	it("default mapper skips itemType when absent", () => {
		const transform = createProductTransformer();
		const out = transform({
			product: baseProduct({ itemType: undefined }),
			options: { currencyCode: "BRL" },
		});
		expect(out.additionalProperty).toEqual([
			{ "@type": "PropertyValue", name: "category", value: "category-a, category-b" },
		]);
	});

	it("default mapper skips categories when empty", () => {
		const transform = createProductTransformer();
		const out = transform({
			product: baseProduct({ categories: [] }),
			options: { currencyCode: "BRL" },
		});
		expect(out.additionalProperty).toEqual([
			{ "@type": "PropertyValue", name: "itemType", value: "simple" },
		]);
	});

	it("custom propertyMapper sees site-specific extras via index signature", () => {
		const granadoMapper: PropertyMapper = (product) => [
			{ "@type": "PropertyValue", name: "marca", value: String(product.Marca ?? "") },
			{ "@type": "PropertyValue", name: "volume", value: String(product.Volume ?? "") },
		];
		const transform = createProductTransformer({ propertyMapper: granadoMapper });
		const out = transform({
			product: baseProduct({ Marca: "Granado", Volume: "200ml" }),
			options: { currencyCode: "BRL" },
		});
		expect(out.additionalProperty).toEqual([
			{ "@type": "PropertyValue", name: "marca", value: "Granado" },
			{ "@type": "PropertyValue", name: "volume", value: "200ml" },
		]);
	});

	it("prefers idMagento over id for productID when present", () => {
		const transform = createProductTransformer();
		const out = transform({
			product: baseProduct({ idMagento: "9999" }),
			options: { currencyCode: "BRL" },
		});
		expect(out.productID).toBe("9999");
		expect(out.sku).toBe("SKU-42");
	});

	it("uses id for productID when idMagento is missing", () => {
		const transform = createProductTransformer();
		const out = transform({ product: baseProduct(), options: { currencyCode: "BRL" } });
		expect(out.productID).toBe("SKU-42");
	});

	it("trims whitespace from name", () => {
		const transform = createProductTransformer();
		const out = transform({
			product: baseProduct({ name: "  Padded Name  " }),
			options: { currencyCode: "BRL" },
		});
		expect(out.name).toBe("Padded Name");
		expect(out.isVariantOf?.name).toBe("Padded Name");
	});

	it("falls back to product.currency when options.currencyCode is omitted", () => {
		const transform = createProductTransformer();
		const out = transform({
			product: baseProduct({ currency: "EUR" }),
			options: {},
		});
		const firstOffer = out.offers?.offers[0];
		expect(firstOffer?.priceCurrency).toBe("EUR");
	});

	it("places one variant under isVariantOf.hasVariant", () => {
		const transform = createProductTransformer();
		const out = transform({ product: baseProduct(), options: { currencyCode: "BRL" } });
		expect(out.isVariantOf?.hasVariant).toHaveLength(1);
		expect(out.isVariantOf?.hasVariant?.[0].sku).toBe("SKU-42");
	});

	it("AggregateOffer surfaces high/low correctly when on sale", () => {
		const transform = createProductTransformer();
		const out = transform({ product: baseProduct(), options: { currencyCode: "BRL" } });
		expect(out.offers?.highPrice).toBe(100);
		expect(out.offers?.lowPrice).toBe(80);
	});

	it("AggregateOffer high === low when no salePrice is set", () => {
		const transform = createProductTransformer();
		const out = transform({
			product: baseProduct({ salePrice: undefined }),
			options: { currencyCode: "BRL" },
		});
		expect(out.offers?.highPrice).toBe(100);
		expect(out.offers?.lowPrice).toBe(100);
	});
});
