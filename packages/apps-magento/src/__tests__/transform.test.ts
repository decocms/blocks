/**
 * Tests for utils/transform.ts — the schema.org mapping layer.
 *
 * Parity goals against deco-cx/apps/magento/utils/transform.ts:
 * each helper is exercised against the same input shapes the legacy
 * code handled and we assert on the same output shapes the storefront
 * sections render against. The goal is to keep this file as a
 * regression dam so future refactors don't silently shift output
 * structure on real consumer sites.
 */
import { describe, expect, it } from "vitest";
import type { MagentoProduct } from "../utils/client/types";
import { toBreadcrumbList, toImages, toOffer, toProduct, toSeo, toURL } from "../utils/transform";

const baseProduct = (): MagentoProduct => ({
	id: 42,
	sku: "SKU-42",
	name: "Test Product",
	price: 100,
	status: 1,
	visibility: 4,
	type_id: "simple",
	created_at: "",
	updated_at: "",
	weight: 0,
	url: "https://loja.example.com/p/test",
	extension_attributes: {
		category_links: [],
		stock_item: {
			item_id: 1,
			product_id: 42,
			stock_id: 1,
			is_in_stock: true,
			qty: 7,
		},
	},
	custom_attributes: [
		{ attribute_code: "title", value: "Test Title" },
		{ attribute_code: "meta_title", value: "Test Meta Title" },
		{ attribute_code: "meta_description", value: "Test Meta Description" },
	],
	currency_code: "BRL",
	price_info: {
		final_price: 80,
		max_price: 100,
		max_regular_price: 100,
		minimal_regular_price: 100,
		special_price: null,
		minimal_price: 80,
		regular_price: 100,
		formatted_prices: {
			final_price: "R$ 80,00",
			max_price: "R$ 100,00",
			minimal_price: "R$ 80,00",
			max_regular_price: "R$ 100,00",
			minimal_regular_price: null,
			special_price: null,
			regular_price: "R$ 100,00",
		},
		extension_attributes: {
			msrp: {
				msrp_price: "",
				is_applicable: "",
				is_shown_price_on_gesture: "",
				msrp_message: "",
				explanation_message: "",
			},
			tax_adjustments: {
				final_price: 80,
				max_price: 100,
				max_regular_price: 100,
				minimal_regular_price: 100,
				special_price: 80,
				minimal_price: 80,
				regular_price: 100,
				formatted_prices: {
					final_price: "R$ 80,00",
					max_price: "R$ 100,00",
					minimal_price: "R$ 80,00",
					max_regular_price: "R$ 100,00",
					minimal_regular_price: null,
					special_price: "R$ 80,00",
					regular_price: "R$ 100,00",
				},
			},
			weee_attributes: [],
			weee_adjustment: "",
		},
	},
});

describe("toURL", () => {
	it("promotes protocol-relative URLs to https", () => {
		expect(toURL("//cdn.example.com/img.jpg")).toBe("https://cdn.example.com/img.jpg");
	});

	it("leaves https URLs untouched", () => {
		expect(toURL("https://x.com/i.jpg")).toBe("https://x.com/i.jpg");
	});

	it("leaves http URLs untouched (no upgrade)", () => {
		// Prod only promotes the // form; http:// is passed through to match.
		expect(toURL("http://x.com/i.jpg")).toBe("http://x.com/i.jpg");
	});
});

describe("toSeo", () => {
	it("prefers meta_title over title", () => {
		const seo = toSeo(
			[
				{ attribute_code: "title", value: "A" },
				{ attribute_code: "meta_title", value: "B" },
				{ attribute_code: "meta_description", value: "D" },
			],
			"https://x.test/p",
		);
		expect(seo).toEqual({ title: "B", description: "D", canonical: "https://x.test/p" });
	});

	it("falls back to title when meta_title is absent", () => {
		const seo = toSeo([{ attribute_code: "title", value: "A" }], "https://x.test/p");
		expect(seo.title).toBe("A");
	});

	it("returns empty title/description when neither attr is present", () => {
		const seo = toSeo([], "https://x.test/p");
		expect(seo).toEqual({ title: "", description: "", canonical: "https://x.test/p" });
	});

	it("joins string-array attribute values with comma+space", () => {
		const seo = toSeo(
			[{ attribute_code: "meta_description", value: ["a", "b", "c"] }],
			"https://x.test/p",
		);
		expect(seo.description).toBe("a, b, c");
	});
});

describe("toOffer", () => {
	it("returns [] when price_info is absent", () => {
		const p = baseProduct();
		p.price_info = undefined;
		expect(toOffer(p, 30, 10)).toEqual([]);
	});

	it("maps InStock availability when stock_item.is_in_stock=true", () => {
		const offers = toOffer(baseProduct(), 30, 10);
		expect(offers[0].availability).toBe("https://schema.org/InStock");
		expect(offers[0].inventoryLevel).toEqual({ value: 7 });
	});

	it("maps OutOfStock availability when stock_item.is_in_stock=false", () => {
		const p = baseProduct();
		p.extension_attributes.stock_item!.is_in_stock = false;
		const offers = toOffer(p, 30, 10);
		expect(offers[0].availability).toBe("https://schema.org/OutOfStock");
		expect(offers[0].inventoryLevel).toEqual({ value: 0 });
	});

	it("emits ListPrice + SalePrice in priceSpecification", () => {
		const offers = toOffer(baseProduct(), 30, 10);
		const types = (offers[0].priceSpecification ?? []).map((s: any) => s.priceType);
		expect(types).toContain("https://schema.org/ListPrice");
		expect(types).toContain("https://schema.org/SalePrice");
	});

	it("calculates installments capped by maxInstallments AND minInstallmentValue", () => {
		// finalPrice 80, minInstallmentValue 30 → floor(80/30) = 2 possible
		// maxInstallments 10 → bounded by 2
		const offers = toOffer(baseProduct(), 30, 10);
		const installments = (offers[0].priceSpecification ?? []).filter(
			(s: any) => s.priceComponentType === "https://schema.org/Installment",
		);
		expect(installments.length).toBe(2);
		expect((installments[0] as any).description).toBe("À vista");
		expect((installments[1] as any).description).toBe("2x sem juros");
	});

	it("always emits at least 1 installment (À vista) when finalPrice < minInstallmentValue", () => {
		// finalPrice 80, minInstallmentValue 200 → floor = 0 → || 1
		const offers = toOffer(baseProduct(), 200, 10);
		const installments = (offers[0].priceSpecification ?? []).filter(
			(s: any) => s.priceComponentType === "https://schema.org/Installment",
		);
		expect(installments.length).toBe(1);
		expect((installments[0] as any).description).toBe("À vista");
	});
});

describe("toImages", () => {
	it("maps media_gallery_entries when imagesUrl is provided", () => {
		const p = baseProduct();
		p.media_gallery_entries = [
			{
				id: 1,
				media_type: "image",
				label: null,
				position: 1,
				disabled: false,
				types: [],
				file: "/x/y.jpg",
			},
		];
		const imgs = toImages(p, "https://cdn.example/media");
		expect(imgs).toEqual([
			{
				"@type": "ImageObject",
				encodingFormat: "image",
				alternateName: "/x/y.jpg",
				url: "https://cdn.example/media/x/y.jpg",
				disabled: false,
			},
		]);
	});

	it("falls back to `images` when imagesUrl is empty", () => {
		const p = baseProduct();
		p.images = [
			{
				url: "https://x.test/i.jpg",
				code: "image",
				height: 1,
				width: 1,
				label: "x",
				resized_width: 1,
				resized_height: 1,
				disabled: false,
			},
		];
		const imgs = toImages(p, "");
		expect(imgs?.[0]).toMatchObject({ url: "https://x.test/i.jpg", alternateName: "x" });
	});

	it("promotes // URLs to https via toURL inside the prefix", () => {
		const p = baseProduct();
		p.media_gallery_entries = [
			{
				id: 1,
				media_type: "image",
				label: null,
				position: 1,
				disabled: false,
				types: [],
				file: "/x.jpg",
			},
		];
		const imgs = toImages(p, "//cdn.example/m");
		expect(imgs?.[0].url).toBe("https://cdn.example/m/x.jpg");
	});
});

describe("toBreadcrumbList", () => {
	const PRODUCT_URL = new URL("https://x.test/produto/abc");

	it("returns a single ListItem with the product name when categories=[] and flag=true", () => {
		const out = toBreadcrumbList(
			[],
			true,
			{ "@type": "Product", productID: "1", sku: "1", name: "Foo" } as any,
			PRODUCT_URL,
		);
		expect(out).toEqual([
			{
				"@type": "ListItem",
				name: "Foo",
				position: 1,
				item: "https://x.test/Foo",
			},
		]);
	});

	it("maps each valid category to a ListItem ordered by position", () => {
		const out = toBreadcrumbList(
			[{ id: 1, name: "A", position: 1 } as any, { id: 2, name: "B", position: 2 } as any],
			false,
			{ name: "Foo" } as any,
			PRODUCT_URL,
		);
		expect(out).toEqual([
			{ "@type": "ListItem", name: "A", position: 1, item: "https://x.test/A" },
			{ "@type": "ListItem", name: "B", position: 2, item: "https://x.test/B" },
		]);
	});

	it("filters out null/empty-name/zero-position categories", () => {
		const out = toBreadcrumbList(
			[
				null,
				{ id: 1, name: "", position: 1 } as any,
				{ id: 2, name: "B", position: 0 } as any,
				{ id: 3, name: "C", position: 3 } as any,
			],
			false,
			{ name: "Foo" } as any,
			PRODUCT_URL,
		);
		expect(out).toEqual([
			{ "@type": "ListItem", name: "C", position: 3, item: "https://x.test/C" },
		]);
	});
});

describe("toProduct", () => {
	it("maps a base product into a schema.org Product with offers, image, additionalProperty", () => {
		const out = toProduct({
			product: baseProduct(),
			options: {
				currencyCode: "BRL",
				imagesUrl: "",
				maxInstallments: 10,
				minInstallmentValue: 30,
			},
		});

		expect(out["@type"]).toBe("Product");
		expect(out.productID).toBe("42");
		expect(out.sku).toBe("SKU-42");
		expect(out.name).toBe("Test Product");
		expect(out.url).toBe("https://loja.example.com/p/test");
		expect((out.offers as any).highPrice).toBe(100);
		expect((out.offers as any).lowPrice).toBe(80);
		expect(out.additionalProperty?.length).toBe(3);
	});

	it("wraps the product in isVariantOf with the same productID", () => {
		const out = toProduct({
			product: baseProduct(),
			options: { maxInstallments: 10, minInstallmentValue: 30 },
		});
		expect(out.isVariantOf?.productGroupID).toBe("42");
		expect(out.isVariantOf?.hasVariant?.[0].productID).toBe("42");
	});

	it("falls back to product.price when price_info is absent for highPrice/lowPrice", () => {
		const p = baseProduct();
		p.price_info = undefined;
		const out = toProduct({
			product: p,
			options: { maxInstallments: 10, minInstallmentValue: 30 },
		});
		expect((out.offers as any).highPrice).toBe(100);
		expect((out.offers as any).lowPrice).toBe(100);
		// And offers array is empty when price_info is absent (toOffer returns [])
		expect((out.offers as any).offerCount).toBe(0);
	});
});
