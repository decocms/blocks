import { beforeEach, describe, expect, it, vi } from "vitest";

// `legacyProductList` is the SHELF loader. It accepted no payload-shaping
// options, so every shelf paid the full product for every entry — measured on a
// real home shelf (`count: 28`): 1095 KB, 39.1 KB per product, of which
// `isVariantOf` 19.1 KB and the 48-rung `offers.priceSpecification` 12.8 KB.
// `legacyProductListingPage` already took them; this file pins the pass-through,
// because declaring the options WITHOUT forwarding them is exactly the bug the
// PLP loader had.

vi.mock("../../client", () => ({
	getVtexConfig: () => ({ account: "test", salesChannel: "1" }),
	vtexFetch: vi.fn(),
	vtexFetchResponse: vi.fn(),
}));

import { vtexFetch } from "../../client";
import { legacyProductList } from "../legacy";

const sellers = (price: number) => [
	{
		sellerId: "1",
		sellerName: "Seller One",
		sellerDefault: true,
		commertialOffer: {
			AvailableQuantity: 5,
			Price: price,
			ListPrice: price + 30,
			PriceWithoutDiscount: price + 30,
			spotPrice: price,
			PriceValidUntil: "2025-12-31",
			// A real ladder: every method the store accepts, every installment count.
			Installments: ["Visa", "Master", "Amex", "Boleto"].flatMap((method) =>
				Array.from({ length: 4 }, (_, i) => ({
					Value: price / (i + 1),
					NumberOfInstallments: i + 1,
					Name: `${method} ${i + 1}x`,
					InterestRate: 0,
					TotalValuePlusInterestRate: price,
					PaymentSystemName: method,
				})),
			),
			GiftSkuIds: [],
			teasers: [],
		},
	},
];

const sku = (itemId: string, price: number) => ({
	itemId,
	name: `SKU ${itemId}`,
	nameComplete: `SKU ${itemId}`,
	complementName: "",
	ean: "1234567890123",
	referenceId: [{ Key: "RefId", Value: `REF-${itemId}` }],
	images: Array.from({ length: 4 }, (_, i) => ({
		imageId: `${itemId}-${i}`,
		imageUrl: `https://img.com/${itemId}-${i}.jpg`,
		imageText: `img${i}`,
		imageLabel: `label${i}`,
	})),
	sellers: sellers(price),
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
	productName: "Test Product",
	brand: "TestBrand",
	brandId: 1,
	brandImageUrl: null,
	linkText: "test-product",
	productReference: "REF1",
	categoryId: "1",
	productTitle: "Test Product",
	metaTagDescription: "meta",
	clusterHighlights: {},
	productClusters: {},
	searchableClusters: {},
	categories: ["/Electronics/"],
	categoriesIds: ["/1/"],
	link: "https://test/test-product/p",
	description: "x".repeat(2000),
	items: [sku("SKU1", 90), sku("SKU2", 60), sku("SKU3", 120)],
	allSpecifications: [],
	allSpecificationsGroups: [],
	skuSpecifications: [],
	releaseDate: "2024-01-01",
});

const opts = { query: { count: 1 } as any, baseUrl: "https://example.com" };
const ladderOf = (p: any) => p?.offers?.offers?.[0]?.priceSpecification ?? [];

describe("legacyProductList — payload-shaping options reach toProduct", () => {
	beforeEach(() => {
		(vtexFetch as any).mockReset();
		(vtexFetch as any).mockResolvedValue([legacyProduct()]);
	});

	it("no options: full product, full ladder, every variant, every image", async () => {
		const [p] = (await legacyProductList(opts)) as any[];
		expect(ladderOf(p).length).toBeGreaterThan(10);
		expect(p.isVariantOf.hasVariant).toHaveLength(3);
		expect(ladderOf(p.isVariantOf.hasVariant[0]).length).toBeGreaterThan(10);
		expect(p.image).toHaveLength(4);
		expect(p.description).toBeTruthy();
	});

	it("leanVariants empties the ladder on every variant", async () => {
		const [p] = (await legacyProductList({ ...opts, leanVariants: true })) as any[];
		for (const v of p.isVariantOf.hasVariant) expect(ladderOf(v)).toEqual([]);
	});

	it("displayedVariantId keeps the ladder on the one variant the card renders", async () => {
		const [p] = (await legacyProductList({
			...opts,
			leanVariants: true,
			displayedVariantId: (items: any[]) => items[1].itemId,
		})) as any[];
		const kept = p.isVariantOf.hasVariant.find((v: any) => v.sku === "SKU2");
		expect(ladderOf(kept).length).toBeGreaterThan(0);
		// ...and it is the LEAN shape, not a second full product.
		expect(kept.description).toBeUndefined();
	});

	it("priceSpecifications rewrites the root ladder with the caller's rule", async () => {
		const [p] = (await legacyProductList({
			...opts,
			priceSpecifications: (specs) => specs.filter((s) => !s.priceComponentType),
		})) as any[];
		expect(ladderOf(p).every((s: any) => !s.priceComponentType)).toBe(true);
		expect(ladderOf(p).length).toBeLessThan(10);
	});

	it("maxImages caps image[] by position", async () => {
		const [p] = (await legacyProductList({ ...opts, maxImages: 2 })) as any[];
		expect(p.image).toHaveLength(2);
	});

	it("every option absent is byte-for-byte the previous output", async () => {
		const [before] = (await legacyProductList(opts)) as any[];
		const [after] = (await legacyProductList({
			...opts,
			leanVariants: undefined,
			displayedVariantId: undefined,
			maxImages: undefined,
			priceSpecifications: undefined,
		})) as any[];
		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
	});
});
