import { describe, expect, it } from "vitest";
import type { Offer, Product } from "@decocms/apps-commerce/types";
import {
	aggregateOffers,
	bestOfferFirst,
	categoryTreeToNavbar,
	filtersFromURL,
	filtersToSearchParams,
	forceHttpsOnAssets,
	inStock,
	legacyFacetsFromURL,
	legacyFacetsNormalize,
	mergeFacets,
	normalizeFacet,
	parsePageType,
	pickSku,
	SCHEMA_IN_STOCK,
	SCHEMA_OUT_OF_STOCK,
	sortProducts,
	toAdditionalPropertyCategory,
	toAdditionalPropertyCluster,
	toAdditionalPropertyReferenceId,
	toAdditionalPropertySpecification,
	toBrand,
	toPostalAddress,
	toProductVariant,
} from "../transform";

const makeOffer = (price: number, availability: string): Offer => ({
	"@type": "Offer",
	price,
	availability: availability as Offer["availability"],
	priceSpecification: [],
	inventoryLevel: { value: 1 },
});

describe("inStock", () => {
	it("returns true when in stock", () => {
		expect(inStock(makeOffer(10, SCHEMA_IN_STOCK))).toBe(true);
	});

	it("returns false when out of stock", () => {
		expect(inStock(makeOffer(10, SCHEMA_OUT_OF_STOCK))).toBe(false);
	});
});

describe("bestOfferFirst", () => {
	it("sorts in-stock before out-of-stock", () => {
		const inStockOffer = makeOffer(100, SCHEMA_IN_STOCK);
		const outOfStockOffer = makeOffer(10, SCHEMA_OUT_OF_STOCK);
		expect(bestOfferFirst(inStockOffer, outOfStockOffer)).toBe(-1);
		expect(bestOfferFirst(outOfStockOffer, inStockOffer)).toBe(1);
	});

	it("sorts by price when both in stock", () => {
		const cheap = makeOffer(10, SCHEMA_IN_STOCK);
		const expensive = makeOffer(100, SCHEMA_IN_STOCK);
		expect(bestOfferFirst(cheap, expensive)).toBeLessThan(0);
		expect(bestOfferFirst(expensive, cheap)).toBeGreaterThan(0);
	});

	it("returns 0 for equal offers", () => {
		const a = makeOffer(50, SCHEMA_IN_STOCK);
		const b = makeOffer(50, SCHEMA_IN_STOCK);
		expect(bestOfferFirst(a, b)).toBe(0);
	});
});

describe("aggregateOffers", () => {
	it("returns undefined for empty array", () => {
		expect(aggregateOffers([])).toBeUndefined();
	});

	it("aggregates single offer", () => {
		const offer = makeOffer(100, SCHEMA_IN_STOCK);
		const result = aggregateOffers([offer], "BRL");
		expect(result).toEqual({
			"@type": "AggregateOffer",
			priceCurrency: "BRL",
			highPrice: 100,
			lowPrice: 100,
			offerCount: 1,
			offers: [offer],
		});
	});

	it("finds low and high prices across multiple offers", () => {
		const offers = [
			makeOffer(50, SCHEMA_IN_STOCK),
			makeOffer(100, SCHEMA_IN_STOCK),
			makeOffer(25, SCHEMA_IN_STOCK),
		];
		const result = aggregateOffers(offers, "BRL");
		expect(result?.lowPrice).toBe(25);
		expect(result?.highPrice).toBe(100);
		expect(result?.offerCount).toBe(3);
	});

	it("ignores out-of-stock offers for high price", () => {
		const offers = [makeOffer(25, SCHEMA_IN_STOCK), makeOffer(200, SCHEMA_OUT_OF_STOCK)];
		const result = aggregateOffers(offers, "BRL");
		expect(result?.highPrice).toBe(25);
	});
});

describe("pickSku", () => {
	const makeProduct = (
		items: Array<{
			itemId: string;
			sellers: Array<{ commertialOffer: { AvailableQuantity: number } }>;
		}>,
	) => ({ items, origin: "intelligent-search" }) as any;

	it("returns specified SKU", () => {
		const product = makeProduct([
			{ itemId: "1", sellers: [{ commertialOffer: { AvailableQuantity: 0 } }] },
			{ itemId: "2", sellers: [{ commertialOffer: { AvailableQuantity: 5 } }] },
		]);
		expect(pickSku(product, "2").itemId).toBe("2");
	});

	it("returns first available SKU when no ID specified", () => {
		const product = makeProduct([
			{ itemId: "1", sellers: [{ commertialOffer: { AvailableQuantity: 0 } }] },
			{ itemId: "2", sellers: [{ commertialOffer: { AvailableQuantity: 5 } }] },
		]);
		expect(pickSku(product).itemId).toBe("2");
	});

	it("falls back to first SKU when none available", () => {
		const product = makeProduct([
			{ itemId: "1", sellers: [{ commertialOffer: { AvailableQuantity: 0 } }] },
			{ itemId: "2", sellers: [{ commertialOffer: { AvailableQuantity: 0 } }] },
		]);
		expect(pickSku(product).itemId).toBe("1");
	});

	it("falls back to first SKU when specified ID not found", () => {
		const product = makeProduct([
			{ itemId: "1", sellers: [{ commertialOffer: { AvailableQuantity: 5 } }] },
		]);
		expect(pickSku(product, "999").itemId).toBe("1");
	});
});

describe("toAdditionalPropertyCategory", () => {
	it("creates category property value", () => {
		const result = toAdditionalPropertyCategory({ propertyID: "123", value: "Shoes" });
		expect(result).toEqual({
			"@type": "PropertyValue",
			name: "category",
			propertyID: "123",
			value: "Shoes",
		});
	});
});

describe("toAdditionalPropertyCluster", () => {
	it("creates cluster property value", () => {
		const result = toAdditionalPropertyCluster({ propertyID: "456", value: "Sale" });
		expect(result).toEqual({
			"@type": "PropertyValue",
			name: "cluster",
			propertyID: "456",
			value: "Sale",
			description: undefined,
		});
	});

	it("marks as highlight when in set", () => {
		const highlights = new Set(["456"]);
		const result = toAdditionalPropertyCluster({ propertyID: "456", value: "Sale" }, highlights);
		expect(result.description).toBe("highlight");
	});

	it("does not mark as highlight when not in set", () => {
		const highlights = new Set(["789"]);
		const result = toAdditionalPropertyCluster({ propertyID: "456", value: "Sale" }, highlights);
		expect(result.description).toBeUndefined();
	});
});

describe("toAdditionalPropertyReferenceId", () => {
	it("creates reference ID property value", () => {
		const result = toAdditionalPropertyReferenceId({ name: "RefId", value: "ABC123" });
		expect(result).toEqual({
			"@type": "PropertyValue",
			name: "RefId",
			value: "ABC123",
			valueReference: "ReferenceID",
		});
	});
});

describe("toAdditionalPropertySpecification", () => {
	it("creates specification property value", () => {
		const result = toAdditionalPropertySpecification({ name: "Color", value: "Red" });
		expect(result).toEqual({
			"@type": "PropertyValue",
			name: "Color",
			value: "Red",
			propertyID: undefined,
			valueReference: "SPECIFICATION",
		});
	});

	it("includes propertyID when provided", () => {
		const result = toAdditionalPropertySpecification({
			name: "Color",
			value: "Red",
			propertyID: "group1",
		});
		expect(result.propertyID).toBe("group1");
	});
});

describe("filtersToSearchParams", () => {
	it("converts facets to search params", () => {
		const facets = [
			{ key: "category", value: "shoes" },
			{ key: "brand", value: "nike" },
		];
		const params = filtersToSearchParams(facets);
		expect(params.get("filter.category")).toBe("shoes");
		expect(params.get("filter.brand")).toBe("nike");
	});

	it("preserves existing params", () => {
		const existing = new URLSearchParams("page=1");
		const params = filtersToSearchParams([{ key: "brand", value: "nike" }], existing);
		expect(params.get("page")).toBe("1");
		expect(params.get("filter.brand")).toBe("nike");
	});
});

describe("legacyFacetsNormalize", () => {
	it("normalizes legacy price format", () => {
		const result = legacyFacetsNormalize("priceFrom", "de-34,90-a-56,90");
		expect(result).toEqual({ key: "price", value: "34.90:56.90" });
	});

	it("maps legacy key names", () => {
		const result = legacyFacetsNormalize("productClusterSearchableIds", "123");
		expect(result).toEqual({ key: "productClusterIds", value: "123" });
	});

	it("passes through unknown keys", () => {
		const result = legacyFacetsNormalize("brand", "nike");
		expect(result).toEqual({ key: "brand", value: "nike" });
	});
});

describe("legacyFacetsFromURL", () => {
	it("extracts facets from URL with map param", () => {
		const url = new URL("https://example.com/shoes/nike?map=c,brand");
		const result = legacyFacetsFromURL(url);
		expect(result).toEqual([
			{ key: "c", value: "shoes" },
			{ key: "brand", value: "nike" },
		]);
	});

	it("returns empty array when no map param", () => {
		const url = new URL("https://example.com/shoes");
		const result = legacyFacetsFromURL(url);
		expect(result).toEqual([]);
	});

	it("handles mismatched lengths", () => {
		const url = new URL("https://example.com/shoes?map=c,brand,extra");
		const result = legacyFacetsFromURL(url);
		expect(result).toHaveLength(1);
	});
});

describe("filtersFromURL", () => {
	it("extracts both legacy and filter params", () => {
		const url = new URL("https://example.com/shoes?map=c&filter.brand=nike");
		const result = filtersFromURL(url);
		expect(result).toEqual([
			{ key: "c", value: "shoes" },
			{ key: "brand", value: "nike" },
		]);
	});

	it("extracts only filter params when no map", () => {
		const url = new URL("https://example.com/?filter.brand=nike&filter.category=shoes");
		const result = filtersFromURL(url);
		expect(result).toEqual([
			{ key: "brand", value: "nike" },
			{ key: "category", value: "shoes" },
		]);
	});
});

describe("mergeFacets", () => {
	it("merges two facet arrays", () => {
		const f1 = [{ key: "brand", value: "nike" }];
		const f2 = [{ key: "category", value: "shoes" }];
		const result = mergeFacets(f1, f2);
		expect(result).toHaveLength(2);
	});

	it("deduplicates facets", () => {
		const f1 = [{ key: "brand", value: "nike" }];
		const f2 = [{ key: "brand", value: "nike" }];
		const result = mergeFacets(f1, f2);
		expect(result).toHaveLength(1);
	});

	it("keeps both when same key different value", () => {
		const f1 = [{ key: "brand", value: "nike" }];
		const f2 = [{ key: "brand", value: "adidas" }];
		const result = mergeFacets(f1, f2);
		expect(result).toHaveLength(2);
	});
});

describe("categoryTreeToNavbar", () => {
	it("transforms tree to navbar elements", () => {
		const tree = [
			{
				id: 1,
				name: "Shoes",
				hasChildren: true,
				url: "https://example.com/shoes",
				children: [
					{
						id: 2,
						name: "Running",
						hasChildren: false,
						url: "https://example.com/shoes/running",
						children: [],
					},
				],
			},
		];
		const result = categoryTreeToNavbar(tree);
		expect(result).toEqual([
			{
				"@type": "SiteNavigationElement",
				url: "/shoes",
				name: "Shoes",
				children: [
					{
						"@type": "SiteNavigationElement",
						url: "/shoes/running",
						name: "Running",
						children: [],
					},
				],
			},
		]);
	});

	it("returns empty array for empty tree", () => {
		expect(categoryTreeToNavbar([])).toEqual([]);
	});
});

describe("toBrand", () => {
	it("transforms VTEX brand", () => {
		const brand = {
			id: 1,
			name: "Nike",
			imageUrl: "/brands/nike.png",
			metaTagDescription: "Nike brand",
		};
		const result = toBrand(brand as any, "https://example.com");
		expect(result).toEqual({
			"@type": "Brand",
			"@id": "1",
			name: "Nike",
			logo: "https://example.com/brands/nike.png",
			description: "Nike brand",
		});
	});

	it("keeps absolute URLs as-is", () => {
		const brand = {
			id: 1,
			name: "Nike",
			imageUrl: "https://cdn.example.com/nike.png",
			metaTagDescription: "",
		};
		const result = toBrand(brand as any, "https://example.com");
		expect(result.logo).toBe("https://cdn.example.com/nike.png");
	});
});

describe("normalizeFacet", () => {
	it("sets Map to priceFrom and Value to Slug", () => {
		const facet = { Map: "c", Value: "shoes", Slug: "de-10-a-50", Name: "Price", Quantity: 5 };
		const result = normalizeFacet(facet as any);
		expect(result.Map).toBe("priceFrom");
		expect(result.Value).toBe("de-10-a-50");
	});
});

describe("sortProducts", () => {
	it("sorts products by specified order", () => {
		const products = [
			{ "@type": "Product", sku: "3" },
			{ "@type": "Product", sku: "1" },
			{ "@type": "Product", sku: "2" },
		] as unknown as Product[];
		const result = sortProducts(products, ["1", "2", "3"], "sku");
		expect(result.map((p) => p.sku)).toEqual(["1", "2", "3"]);
	});

	it("returns undefined for missing IDs", () => {
		const products = [{ "@type": "Product", sku: "1" }] as unknown as Product[];
		const result = sortProducts(products, ["1", "999"], "sku");
		expect(result[0].sku).toBe("1");
		expect(result[1]).toBeUndefined();
	});
});

describe("parsePageType", () => {
	it("maps FullText to Search", () => {
		expect(parsePageType({ pageType: "FullText" } as any)).toBe("Search");
	});

	it("maps NotFound to Unknown", () => {
		expect(parsePageType({ pageType: "NotFound" } as any)).toBe("Unknown");
	});

	it("passes through other types", () => {
		expect(parsePageType({ pageType: "Department" } as any)).toBe("Department");
		expect(parsePageType({ pageType: "Brand" } as any)).toBe("Brand");
	});
});

describe("forceHttpsOnAssets", () => {
	it("converts http to https on item images", () => {
		const orderForm = {
			items: [
				{ imageUrl: "http://example.com/img.jpg" },
				{ imageUrl: "https://example.com/img2.jpg" },
			],
		};
		const result = forceHttpsOnAssets(orderForm as any);
		expect(result.items[0].imageUrl).toBe("https://example.com/img.jpg");
		expect(result.items[1].imageUrl).toBe("https://example.com/img2.jpg");
	});

	it("handles items without imageUrl", () => {
		const orderForm = { items: [{ imageUrl: undefined }] };
		const result = forceHttpsOnAssets(orderForm as any);
		expect(result.items[0].imageUrl).toBeUndefined();
	});
});

describe("toPostalAddress", () => {
	it("transforms VTEX address to PostalAddress", () => {
		const address = {
			addressId: "addr1",
			country: "BRA",
			city: "São Paulo",
			state: "SP",
			neighborhood: "Pinheiros",
			postalCode: "05422-000",
			street: "Rua dos Pinheiros",
			number: "123",
			addressName: "Home",
			receiverName: "John Doe",
			complement: "Apt 1",
			reference: "Near the park",
			geoCoordinates: [-23.5668, -46.6901],
		};
		const result = toPostalAddress(address as any);
		expect(result["@type"]).toBe("PostalAddress");
		expect(result["@id"]).toBe("addr1");
		expect(result.addressCountry).toBe("BRA");
		expect(result.addressLocality).toBe("São Paulo");
		expect(result.addressRegion).toBe("SP");
		expect(result.postalCode).toBe("05422-000");
		expect(result.streetAddress).toBe("Rua dos Pinheiros");
		expect(result.identifier).toBe("123");
		expect(result.name).toBe("Home");
		expect(result.alternateName).toBe("John Doe");
	});

	it("returns undefined for empty optional fields", () => {
		const address = {
			addressId: "addr1",
			country: "BRA",
			city: "SP",
			state: "SP",
			postalCode: "05422-000",
			street: "Rua X",
		};
		const result = toPostalAddress(address as any);
		expect(result.areaServed).toBeUndefined();
		expect(result.identifier).toBeUndefined();
		expect(result.name).toBeUndefined();
	});
});

describe("toProductVariant", () => {
	const makeISProduct = (overrides: Record<string, unknown> = {}) =>
		({
			origin: "intelligent-search",
			productId: "PROD1",
			productName: "Test Product",
			brand: "TestBrand",
			brandId: 1,
			brandImageUrl: null,
			productReference: "REF1",
			description: "Full description HTML",
			releaseDate: "2024-01-01",
			linkText: "test-product",
			categories: ["/Electronics/TVs/"],
			categoriesIds: ["/1/2/"],
			categoryId: "2",
			productClusters: { "100": "Sale" },
			clusterHighlights: {},
			items: [],
			...overrides,
		}) as any;

	const makeISSku = (overrides: Record<string, unknown> = {}) =>
		({
			itemId: "SKU1",
			name: "Test SKU",
			ean: "1234567890123",
			referenceId: [{ Key: "RefId", Value: "REF-SKU1" }],
			images: [
				{ imageUrl: "https://img.com/1.jpg", imageText: "Front", imageLabel: "front" },
				{ imageUrl: "https://img.com/2.jpg", imageText: "Back", imageLabel: "back" },
				{ imageUrl: "https://img.com/3.jpg", imageText: "Side", imageLabel: "side" },
			],
			videos: ["https://video.com/1.mp4"],
			sellers: [
				{
					sellerId: "1",
					sellerName: "Seller One",
					commertialOffer: {
						AvailableQuantity: 10,
						Price: 99.9,
						ListPrice: 129.9,
						spotPrice: 89.9,
						PriceValidUntil: "2025-12-31",
						Installments: [
							{
								Value: 33.3,
								NumberOfInstallments: 3,
								Name: "Visa",
								InterestRate: 0,
								TotalValuePlusInterestRate: 99.9,
								PaymentSystemName: "Visa",
							},
						],
						GiftSkuIds: [],
						teasers: [],
					},
				},
			],
			variations: [
				{ name: "Cor", values: ["Preto"] },
				{ name: "Voltagem", values: ["220V"] },
				{ name: "Tamanho", values: ["G"] },
			],
			kitItems: [],
			complementName: "Complement",
			estimatedDateArrival: null,
			modalType: null,
			...overrides,
		}) as any;

	const baseOptions = {
		baseUrl: "https://example.com",
		priceCurrency: "BRL",
	};

	it("returns minimal product shape", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, baseOptions);

		expect(result["@type"]).toBe("Product");
		expect(result.productID).toBe("SKU1");
		expect(result.sku).toBe("SKU1");
		expect(result.name).toBe("Test SKU");
		expect(result.url).toContain("/test-product/p");
		expect(result.inProductGroupWithID).toBe("PROD1");
	});

	it("drops description, video, brand, gtin, releaseDate, isVariantOf", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, baseOptions);

		expect(result.video).toBeUndefined();
		expect(result.description).toBeUndefined();
		expect(result.brand).toBeUndefined();
		expect(result.gtin).toBeUndefined();
		expect(result.releaseDate).toBeUndefined();
		expect(result.alternateName).toBeUndefined();
		expect(result.isVariantOf).toBeUndefined();
		expect(result.isAccessoryOrSparePartFor).toBeUndefined();
		expect(result.category).toBeUndefined();
	});

	it("includes image[0] by default — selectors render thumbnails from it", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, baseOptions);

		expect(result.image).toHaveLength(1);
		expect(result.image?.[0]).toMatchObject({
			"@type": "ImageObject",
			url: "https://img.com/1.jpg",
			encodingFormat: "image",
		});
	});

	it("includes real inventoryLevel by default — selectors gate stock state on it", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, baseOptions);

		const offer = result.offers!.offers[0];
		expect(offer.inventoryLevel?.value).toBe(10);
	});

	it("drops image when variantIncludeImage: false", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, {
			...baseOptions,
			variantIncludeImage: false,
		});

		expect(result.image).toBeUndefined();
	});

	it("zeros inventoryLevel when variantIncludeInventory: false (legacy lean behavior)", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, {
			...baseOptions,
			variantIncludeInventory: false,
		});

		const offer = result.offers!.offers[0];
		expect(offer.inventoryLevel?.value).toBe(0);
	});

	it("filters additionalProperty to variant-differentiating names only", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, baseOptions);

		const propNames = result.additionalProperty?.map((p) => p.name) ?? [];
		// Should only contain Cor, Voltagem, Tamanho (from VARIANT_PROPERTY_NAMES)
		for (const name of propNames) {
			expect(["Cor", "Voltagem", "Tamanho"]).toContain(name);
		}
		expect(propNames.length).toBeGreaterThan(0);
	});

	it("respects custom variantPropertyNames", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, {
			...baseOptions,
			variantPropertyNames: new Set(["Cor"]),
		});

		const propNames = result.additionalProperty?.map((p) => p.name) ?? [];
		expect(propNames).toEqual(["Cor"]);
	});

	it("produces lean offers with availability but no priceSpecification details", () => {
		const product = makeISProduct({ items: [makeISSku()] });
		const sku = makeISSku();
		const result = toProductVariant(product, sku, baseOptions);

		expect(result.offers).toBeDefined();
		expect(result.offers?.offers).toHaveLength(1);

		const offer = result.offers!.offers[0];
		expect(offer.availability).toBe("https://schema.org/InStock");
		expect(offer.seller).toBe("1");
		expect(offer.priceSpecification).toEqual([]);
	});

	it("handles SKU with no sellers", () => {
		const product = makeISProduct({ items: [makeISSku({ sellers: [] })] });
		const sku = makeISSku({ sellers: [] });
		const result = toProductVariant(product, sku, baseOptions);

		// Should still return a valid product, offers may be undefined (no sellers)
		expect(result["@type"]).toBe("Product");
		expect(result.productID).toBe("SKU1");
	});
});
