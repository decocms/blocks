import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The PDP loader's `seo.canonical` used to be the bare path `/<linkText>/p`.
// deco-cx's `vtex/loaders/legacy/productDetailsPage.ts` publishes
// `new URL(`/${linkText}/p`, url.origin).href`, and a relative canonical leaks
// into `<link rel="canonical">`, `og:url` and the ItemPage JSON-LD `url`.
// Product URLs already come from `storefrontBaseUrl()` — the canonical must
// share their origin.

vi.mock("../../../utils/slugCache", () => ({
	searchBySlug: vi.fn(),
}));

vi.mock("../../paths/PDPDefaultPath", () => ({
	default: vi.fn(async () => ({ possiblePaths: [] })),
}));

import { configureVtex } from "../../../client";
import { searchBySlug } from "../../../utils/slugCache";
import vtexProductDetailsPage from "../productDetailsPage";

const seller = (price: number) => ({
	sellerId: "1",
	sellerName: "Seller One",
	sellerDefault: true,
	commertialOffer: {
		AvailableQuantity: 5,
		Price: price,
		ListPrice: price,
		PriceWithoutDiscount: price,
		spotPrice: price,
		PriceValidUntil: "2025-12-31",
		Installments: [],
		GiftSkuIds: [],
		teasers: [],
	},
});

const sku = (itemId: string) => ({
	itemId,
	name: `SKU ${itemId}`,
	nameComplete: `SKU ${itemId}`,
	complementName: "",
	ean: "1234567890123",
	referenceId: [{ Key: "RefId", Value: `REF-${itemId}` }],
	images: [
		{
			imageId: `${itemId}-0`,
			imageUrl: `https://img.com/${itemId}-0.jpg`,
			imageText: "img",
			imageLabel: "label",
		},
	],
	sellers: [seller(90)],
	Videos: [],
	estimatedDateArrival: null,
	measurementUnit: "un",
	unitMultiplier: 1,
	variations: [],
	attachments: [],
	isKit: false,
});

const legacyProduct = () => ({
	productId: "PROD1",
	productName: "Camisa Paris",
	brand: "TestBrand",
	brandId: 1,
	brandImageUrl: null,
	linkText: "camisa-paris",
	productReference: "REF1",
	categoryId: "1",
	productTitle: "Camisa Paris",
	metaTagDescription: "meta",
	clusterHighlights: {},
	productClusters: {},
	searchableClusters: {},
	categories: ["/Roupas/"],
	categoriesIds: ["/1/"],
	link: "https://test/camisa-paris/p",
	description: "A shirt",
	items: [sku("SKU1")],
	allSpecifications: [],
	allSpecificationsGroups: [],
	skuSpecifications: [],
	releaseDate: "2024-01-01",
});

describe("vtexProductDetailsPage — seo.canonical", () => {
	beforeEach(() => {
		configureVtex({ account: "examplestore", publicUrl: "https://secure.example.com" });
		(searchBySlug as any).mockReset();
		(searchBySlug as any).mockResolvedValue([legacyProduct()]);
	});

	it("is absolute, on the origin of the request being served", async () => {
		const page = await RequestContext.run(
			new Request("https://www.example.com/camisa-paris/p?utm_source=x"),
			() => vtexProductDetailsPage({ slug: "camisa-paris" }),
		);

		expect(page?.seo?.canonical).toBe("https://www.example.com/camisa-paris/p");
	});

	it("shares its origin with the product URL", async () => {
		const page = await RequestContext.run(
			new Request("https://www.example.com/camisa-paris/p"),
			() => vtexProductDetailsPage({ slug: "camisa-paris" }),
		);

		expect(new URL(page!.seo!.canonical!).origin).toBe(new URL(page!.product.url!).origin);
	});

	it("falls back to the configured publicUrl outside a request", async () => {
		const page = await vtexProductDetailsPage({ slug: "camisa-paris" });

		expect(page?.seo?.canonical).toBe("https://secure.example.com/camisa-paris/p");
	});

	it("never carries the request's query string", async () => {
		const page = await RequestContext.run(
			new Request("https://www.example.com/camisa-paris/p?skuId=SKU1&gclid=abc"),
			() => vtexProductDetailsPage({ slug: "camisa-paris", skuId: "SKU1" }),
		);

		expect(page?.seo?.canonical).toBe("https://www.example.com/camisa-paris/p");
	});
});
