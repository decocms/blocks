/**
 * VTEX Workflow loaders (internal/back-office use).
 * These transform raw VTEX Catalog data into schema.org-compatible Product types.
 * NOT intended for storefront rendering — used in data pipelines and workflows.
 *
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/workflow/product.ts
 *   vtex/loaders/workflow/products.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/catalog-api
 */
import type {
	Offer,
	Product,
	PropertyValue,
	UnitPriceSpecification,
} from "@decocms/apps-commerce/types";
import { vtexFetch } from "../client";
import {
	aggregateOffers,
	toAdditionalPropertyCategory,
	toAdditionalPropertyCluster,
	toAdditionalPropertyReferenceId,
	toAdditionalPropertySpecification,
} from "../utils/transform";

/** VTEX prices come in cents — divide by this to get the currency value. */
const CENTS_DIVISOR = 100;

// ---------------------------------------------------------------------------
// Types for pvt Catalog APIs
// ---------------------------------------------------------------------------

interface SkuImage {
	ImageUrl: string;
	ImageName?: string;
	FileId?: string;
}

interface SkuSpecification {
	FieldName: string;
	FieldValues: string[];
	FieldValueIds: number[];
}

interface SkuSeller {
	SellerId: string;
}

interface SkuAlternateIds {
	RefId?: string;
	Ean?: string;
}

interface PvtSku {
	Id: number;
	ProductId: number;
	IsActive: boolean;
	SkuName: string;
	ProductName: string;
	ProductDescription: string;
	DetailUrl: string;
	BrandId: string;
	BrandName: string;
	ReleaseDate?: string;
	Images: SkuImage[];
	SkuSpecifications: SkuSpecification[];
	ProductSpecifications: SkuSpecification[];
	ProductCategories: Record<string, string>;
	ProductClusterNames: Record<string, string>;
	SalesChannels: number[];
	AlternateIds: SkuAlternateIds;
	SkuSellers: SkuSeller[];
}

interface PvtSkuListItem {
	Id: number;
	IsActive: boolean;
}

interface SalesChannel {
	Id: number;
	CurrencyCode: string;
}

interface SimulationItem {
	sellingPrice: number;
	listPrice: number;
	price: number;
	seller: string;
	priceValidUntil: string;
	availability: string;
}

interface SimulationPaymentOption {
	paymentName: string;
	installments: Array<{ count: number; value: number; total: number }>;
}

interface SimulationResponse {
	items?: SimulationItem[];
	paymentData?: { installmentOptions?: SimulationPaymentOption[] };
}

// ---------------------------------------------------------------------------
// workflowProduct
// ---------------------------------------------------------------------------

export interface WorkflowProductOptions {
	/** The SKU ID (stockKeepingUnitId) to load */
	productID: string;
	/** Sales channel for simulation. Defaults to 1. */
	salesChannel?: number;
}

/**
 * Transform a single VTEX SKU (via private Catalog API) into a commerce Product.
 *
 * Fetches the SKU details, all sibling SKUs for the same product, sales channels,
 * and runs checkout simulation for each seller to build offer data.
 *
 * Ported from: vtex/loaders/workflow/product.ts
 */
export async function workflowProduct(opts: WorkflowProductOptions): Promise<Product | null> {
	const sc = opts.salesChannel ?? 1;

	const sku = await vtexFetch<PvtSku>(
		`/api/catalog_system/pvt/sku/stockkeepingunitbyid/${opts.productID}`,
	);

	if (!sku.IsActive) return null;

	const [skus, salesChannels, ...simulations] = await Promise.all([
		vtexFetch<PvtSkuListItem[]>(
			`/api/catalog_system/pvt/sku/stockkeepingunitByProductId/${sku.ProductId}`,
		),
		vtexFetch<SalesChannel[]>("/api/catalog_system/pvt/saleschannel/list"),
		...sku.SkuSellers.map(({ SellerId }) =>
			vtexFetch<SimulationResponse>(
				`/api/checkout/pub/orderForms/simulation?RnbBehavior=1&sc=${sc}`,
				{
					method: "POST",
					body: JSON.stringify({
						items: [{ id: `${sku.Id}`, seller: SellerId, quantity: 1 }],
					}),
				},
			),
		),
	]);

	const channel = salesChannels.find((c) => c.Id === sc);
	const productGroupID = `${sku.ProductId}`;
	const productID = `${sku.Id}`;

	const additionalProperty = [
		sku.AlternateIds.RefId
			? toAdditionalPropertyReferenceId({
					name: "RefId",
					value: sku.AlternateIds.RefId,
				})
			: null,
		...Object.entries(sku.ProductCategories ?? {}).map(([propertyID, value]) =>
			toAdditionalPropertyCategory({ propertyID, value }),
		),
		...Object.entries(sku.ProductClusterNames ?? {}).map(([propertyID, value]) =>
			toAdditionalPropertyCluster({ propertyID, value }),
		),
		...sku.SkuSpecifications.flatMap((spec) =>
			spec.FieldValues.map((value, it) =>
				toAdditionalPropertySpecification({
					propertyID: spec.FieldValueIds[it]?.toString(),
					name: spec.FieldName,
					value,
				}),
			),
		),
		...sku.SalesChannels.map(
			(ch): PropertyValue => ({
				"@type": "PropertyValue",
				name: "salesChannel",
				propertyID: ch.toString(),
			}),
		),
	].filter((p): p is PropertyValue => Boolean(p));

	const groupAdditionalProperty = sku.ProductSpecifications.flatMap((spec) =>
		spec.FieldValues.map((value, it) =>
			toAdditionalPropertySpecification({
				propertyID: spec.FieldValueIds[it]?.toString(),
				name: spec.FieldName,
				value,
			}),
		),
	);

	const offers = simulations
		.flatMap(({ items, paymentData }) =>
			items?.map((item): Offer | null => {
				const { sellingPrice, listPrice, price, seller, priceValidUntil, availability } = item;
				const spotPrice = sellingPrice || price;
				if (!spotPrice || !listPrice) return null;

				return {
					"@type": "Offer",
					price: spotPrice / CENTS_DIVISOR,
					seller,
					priceValidUntil,
					inventoryLevel: {},
					availability:
						availability === "available"
							? "https://schema.org/InStock"
							: "https://schema.org/OutOfStock",
					priceSpecification: [
						{
							"@type": "UnitPriceSpecification",
							priceType: "https://schema.org/ListPrice",
							price: listPrice / CENTS_DIVISOR,
						},
						{
							"@type": "UnitPriceSpecification",
							priceType: "https://schema.org/SalePrice",
							price: spotPrice / CENTS_DIVISOR,
						},
						...(paymentData?.installmentOptions?.flatMap((option): UnitPriceSpecification[] =>
							option.installments.map((i) => ({
								"@type": "UnitPriceSpecification",
								priceType: "https://schema.org/SalePrice",
								priceComponentType: "https://schema.org/Installment",
								name: option.paymentName,
								billingDuration: i.count,
								billingIncrement: i.value / CENTS_DIVISOR,
								price: i.total / CENTS_DIVISOR,
							})),
						) ?? []),
					],
				};
			}),
		)
		.filter((o): o is Offer => Boolean(o));

	return {
		"@type": "Product",
		productID,
		sku: productID,
		inProductGroupWithID: productGroupID,
		category: Object.values(sku.ProductCategories ?? {}).join(" > "),
		url: `${sku.DetailUrl}?skuId=${productID}`,
		name: sku.SkuName,
		gtin: sku.AlternateIds.Ean,
		image: sku.Images.map((img) => ({
			"@type": "ImageObject",
			encodingFormat: "image",
			alternateName: img.ImageName ?? img.FileId,
			url: img.ImageUrl,
		})),
		isVariantOf: {
			"@type": "ProductGroup",
			url: sku.DetailUrl,
			hasVariant:
				skus
					?.filter((x) => x.IsActive)
					.map(({ Id }) => ({
						"@type": "Product",
						productID: `${Id}`,
						sku: `${Id}`,
					})) ?? [],
			additionalProperty: groupAdditionalProperty,
			productGroupID,
			name: sku.ProductName,
			description: sku.ProductDescription,
		},
		additionalProperty,
		releaseDate: sku.ReleaseDate ? new Date(sku.ReleaseDate).toISOString() : undefined,
		brand: {
			"@type": "Brand",
			"@id": sku.BrandId,
			name: sku.BrandName,
		},
		offers: aggregateOffers(offers, channel?.CurrencyCode),
	};
}

// ---------------------------------------------------------------------------
// workflowProducts
// ---------------------------------------------------------------------------

export interface WorkflowProductsOptions {
	page: number;
	pagesize: number;
}

/**
 * Fetch a page of SKU IDs and return minimal Product stubs.
 * Use in batch workflows to enumerate the catalog; call workflowProduct
 * for each ID if full details are needed.
 *
 * Ported from: vtex/loaders/workflow/products.ts
 */
export async function workflowProducts(opts: WorkflowProductsOptions): Promise<Product[]> {
	const params = new URLSearchParams({
		page: String(opts.page),
		pagesize: String(opts.pagesize),
	});

	const ids = await vtexFetch<number[]>(
		`/api/catalog_system/pvt/sku/stockkeepingunitids?${params}`,
	);

	return ids.map((productID) => ({
		"@type": "Product",
		productID: `${productID}`,
		sku: `${productID}`,
	}));
}
