import { describe, expect, it } from "vitest";
import type { ProductShopify, SkuShopify } from "../transform";
import {
	toBreadcrumbItem,
	toBreadcrumbList,
	toFilter,
	toProduct,
	toProductPage,
} from "../transform";

const makeSku = (overrides?: Partial<SkuShopify>): SkuShopify => ({
	id: "gid://shopify/ProductVariant/12345",
	title: "Default / Small",
	availableForSale: true,
	quantityAvailable: 10,
	barcode: "123456789",
	sku: "SKU-001",
	image: { url: "https://cdn.shopify.com/img.jpg", altText: "Product image" },
	price: { amount: "99.90", currencyCode: "BRL" },
	compareAtPrice: { amount: "129.90", currencyCode: "BRL" },
	selectedOptions: [{ name: "Size", value: "Small" }],
	...overrides,
});

const makeProduct = (overrides?: Partial<ProductShopify>): ProductShopify => ({
	id: "gid://shopify/Product/1",
	handle: "test-product",
	title: "Test Product",
	description: "A test product",
	descriptionHtml: "<p>A test product</p>",
	createdAt: "2024-01-01",
	tags: ["sale", "new"],
	vendor: "TestBrand",
	productType: "Clothing",
	seo: { title: "Test Product SEO", description: "SEO description" },
	images: { nodes: [{ url: "https://cdn.shopify.com/img.jpg", altText: "Product" }] },
	media: { nodes: [] },
	variants: { nodes: [makeSku()] },
	collections: {
		nodes: [{ handle: "clothing", title: "Clothing", id: "col1" }],
	},
	...overrides,
});

describe("toBreadcrumbItem", () => {
	it("creates breadcrumb item", () => {
		const result = toBreadcrumbItem({ name: "Home", position: 1, item: "/" });
		expect(result).toEqual({
			"@type": "ListItem",
			name: "Home",
			position: 1,
			item: "/",
		});
	});

	it("decodes URI-encoded names", () => {
		const result = toBreadcrumbItem({ name: "Cal%C3%A7ados", position: 1, item: "/calcados" });
		expect(result.name).toBe("Calçados");
	});
});

describe("toBreadcrumbList", () => {
	it("includes collection in breadcrumb when present", () => {
		const product = makeProduct();
		const sku = makeSku();
		const result = toBreadcrumbList(product, sku);
		expect(result.itemListElement).toHaveLength(2);
		expect(result.itemListElement[0].name).toBe("Clothing");
		expect(result.itemListElement[1].name).toBe("Test Product");
		expect(result.numberOfItems).toBe(2);
	});

	it("omits collection when not present", () => {
		const product = makeProduct({ collections: undefined });
		const sku = makeSku();
		const result = toBreadcrumbList(product, sku);
		expect(result.itemListElement).toHaveLength(1);
		expect(result.itemListElement[0].name).toBe("Test Product");
	});
});

describe("toProduct", () => {
	it("transforms Shopify product to schema.org Product", () => {
		const product = makeProduct();
		const sku = makeSku();
		const url = new URL("https://example.com/products/test-product-12345");
		const result = toProduct(product, sku, url);

		expect(result["@type"]).toBe("Product");
		expect(result.productID).toBe("gid://shopify/ProductVariant/12345");
		expect(result.name).toBe("Default / Small");
		expect(result.description).toBe("A test product");
		expect(result.brand).toEqual({ "@type": "Brand", name: "TestBrand" });
		expect(result.offers?.priceCurrency).toBe("BRL");
		expect(result.offers?.lowPrice).toBe(99.9);
		expect(result.offers?.highPrice).toBe(129.9);
	});

	it("sets availability based on availableForSale", () => {
		const product = makeProduct();
		const sku = makeSku({ availableForSale: false });
		const url = new URL("https://example.com");
		const result = toProduct(product, sku, url);
		expect(result.offers?.offers[0]?.availability).toBe("https://schema.org/OutOfStock");
	});

	it("uses sale price as high price when no compare at price", () => {
		const product = makeProduct();
		const sku = makeSku({ compareAtPrice: null });
		const url = new URL("https://example.com");
		const result = toProduct(product, sku, url);
		expect(result.offers?.highPrice).toBe(99.9);
	});

	it("includes variants at level 0", () => {
		const product = makeProduct();
		const sku = makeSku();
		const url = new URL("https://example.com");
		const result = toProduct(product, sku, url, 0);
		expect(result.isVariantOf?.hasVariant).toHaveLength(1);
	});

	it("does not include variants at level 1", () => {
		const product = makeProduct();
		const sku = makeSku();
		const url = new URL("https://example.com");
		const result = toProduct(product, sku, url, 1);
		expect(result.isVariantOf?.hasVariant).toEqual([]);
	});
});

describe("toProductPage", () => {
	it("creates a full ProductDetailsPage", () => {
		const product = makeProduct();
		const url = new URL("https://example.com/products/test-product-12345");
		const result = toProductPage(product, url);

		expect(result["@type"]).toBe("ProductDetailsPage");
		expect(result.breadcrumbList["@type"]).toBe("BreadcrumbList");
		expect(result.product["@type"]).toBe("Product");
		expect(result.seo?.title).toBe("Test Product SEO");
		expect(result.seo?.description).toBe("SEO description");
	});

	it("falls back to product title/description for SEO", () => {
		const product = makeProduct({ seo: { title: null, description: null } });
		const url = new URL("https://example.com");
		const result = toProductPage(product, url);
		expect(result.seo?.title).toBe("Test Product");
		expect(result.seo?.description).toBe("A test product");
	});

	it("selects specified variant by ID", () => {
		const sku1 = makeSku({ id: "gid://shopify/ProductVariant/111", title: "Red" });
		const sku2 = makeSku({ id: "gid://shopify/ProductVariant/222", title: "Blue" });
		const product = makeProduct({ variants: { nodes: [sku1, sku2] } });
		const url = new URL("https://example.com");
		const result = toProductPage(product, url, 222);
		expect(result.product.name).toBe("Blue");
	});
});

describe("toFilter", () => {
	it("creates toggle filter", () => {
		const filter = {
			id: "filter.v.color",
			label: "Color",
			type: "LIST",
			values: [
				{ id: "1", label: "Red", count: 5, input: '{"productVendor":"Red"}' },
				{ id: "2", label: "Blue", count: 3, input: '{"productVendor":"Blue"}' },
			],
		};
		const url = new URL("https://example.com/collections/all");
		const result = toFilter(filter, url);

		expect(result["@type"]).toBe("FilterToggle");
		expect(result.label).toBe("Color");
		if (result["@type"] === "FilterToggle") {
			expect(result.values).toHaveLength(2);
			expect(result.values[0].label).toBe("Red");
			expect(result.values[0].selected).toBe(false);
		}
	});

	it("creates range filter for PRICE_RANGE type", () => {
		const filter = {
			id: "filter.v.price",
			label: "Price",
			type: "PRICE_RANGE",
			values: [{ id: "1", label: "0-100", count: 10, input: '{"min":0,"max":100}' }],
		};
		const url = new URL("https://example.com");
		const result = toFilter(filter, url);

		expect(result["@type"]).toBe("FilterRange");
		if (result["@type"] === "FilterRange") {
			expect(result.values.min).toBe(0);
			expect(result.values.max).toBe(100);
		}
	});

	it("marks filter as selected when URL contains it", () => {
		const filter = {
			id: "filter.v.vendor",
			label: "Brand",
			type: "LIST",
			values: [{ id: "1", label: "Nike", count: 5, input: '{"productVendor":"Nike"}' }],
		};
		const url = new URL("https://example.com?filter.v.vendor=Nike");
		const result = toFilter(filter, url);
		if (result["@type"] === "FilterToggle") {
			expect(result.values[0].selected).toBe(true);
		}
	});
});
