import type {
	BreadcrumbList,
	Filter,
	ListItem,
	Product,
	ProductDetailsPage,
	PropertyValue,
	UnitPriceSpecification,
} from "@decocms/apps-commerce/types";
import { DEFAULT_IMAGE } from "@decocms/apps-commerce/utils/constants";

type MoneyV2 = { amount: string; currencyCode: string };
type ImageShopify = { url: string; altText?: string | null };
type VideoSource = { url: string };

interface MediaNode {
	alt?: string | null;
	previewImage?: ImageShopify | null;
	mediaContentType: string;
	sources?: VideoSource[];
}

export type SkuShopify = {
	id: string;
	title: string;
	availableForSale: boolean;
	quantityAvailable?: number;
	barcode?: string | null;
	sku?: string | null;
	image?: ImageShopify | null;
	price: MoneyV2;
	compareAtPrice?: MoneyV2 | null;
	selectedOptions: Array<{ name: string; value: string }>;
};

export type CollectionNode = {
	handle: string;
	title: string;
	id?: string;
	description?: string;
	descriptionHtml?: string;
	image?: ImageShopify | null;
};

export type ProductShopify = {
	id: string;
	handle: string;
	title: string;
	description: string;
	descriptionHtml?: string;
	createdAt?: string;
	tags: string[];
	vendor: string;
	productType: string;
	seo?: { title?: string | null; description?: string | null };
	images: { nodes: ImageShopify[] };
	media: { nodes: MediaNode[] };
	variants: { nodes: SkuShopify[] };
	collections?: { nodes: CollectionNode[] };
	metafields?: Array<{
		key: string;
		value: string;
		namespace: string;
		type: string;
		description?: string | null;
		reference?: { image?: { url: string } } | null;
		references?: {
			edges: Array<{ node: { image?: { url: string } } }>;
		} | null;
	} | null>;
};

type FilterValue = { id: string; label: string; count: number; input: string };
type FilterShopify = { id: string; label: string; type: string; values: FilterValue[] };

const getPath = ({ handle }: ProductShopify, sku?: SkuShopify) =>
	sku ? `/products/${handle}-${getIdFromVariantId(sku.id)}` : `/products/${handle}`;

const getIdFromVariantId = (x: string) => {
	const splitted = x.split("/");
	return Number(splitted[splitted.length - 1]);
};

const getVariantIdFromId = (id: number) => `gid://shopify/ProductVariant/${id}`;

const nonEmptyArray = <T>(array: T[] | null | undefined) =>
	Array.isArray(array) && array.length > 0 ? array : null;

export const toProductPage = (
	product: ProductShopify,
	url: URL,
	maybeSkuId?: number,
): ProductDetailsPage => {
	const skuId = maybeSkuId ? getVariantIdFromId(maybeSkuId) : product.variants.nodes[0]?.id;
	let sku = product.variants.nodes.find((node) => node.id === skuId);

	if (!sku) {
		sku = product.variants.nodes[0];
	}

	return {
		"@type": "ProductDetailsPage",
		breadcrumbList: toBreadcrumbList(product, sku),
		product: toProduct(product, sku, url),
		seo: {
			title: product.seo?.title ?? product.title,
			description: product.seo?.description ?? product.description,
			canonical: `${url.origin}${getPath(product, sku)}`,
		},
	};
};

export const toBreadcrumbItem = ({
	name,
	position,
	item,
}: {
	name: string;
	position: number;
	item: string;
}): ListItem => ({
	"@type": "ListItem",
	name: decodeURI(name),
	position,
	item,
});

export const toBreadcrumbList = (product: ProductShopify, sku: SkuShopify): BreadcrumbList => {
	let list: ListItem[] = [];
	const collection = product.collections?.nodes[0];

	if (collection) {
		list = [
			toBreadcrumbItem({
				name: collection.title,
				position: 1,
				item: `/${collection.handle}`,
			}),
			toBreadcrumbItem({
				name: product.title,
				position: 2,
				item: getPath(product, sku),
			}),
		];
	} else {
		list = [
			toBreadcrumbItem({
				name: product.title,
				position: 2,
				item: getPath(product, sku),
			}),
		];
	}

	return {
		"@type": "BreadcrumbList",
		numberOfItems: list.length,
		itemListElement: list,
	};
};

export const toProduct = (
	product: ProductShopify,
	sku: SkuShopify,
	url: URL,
	level = 0,
): Product => {
	const {
		createdAt,
		description,
		images,
		media,
		id: productGroupID,
		variants,
		vendor,
		productType,
	} = product;
	const {
		id: productID,
		barcode,
		selectedOptions,
		image,
		price,
		availableForSale,
		quantityAvailable,
		compareAtPrice,
	} = sku;

	const descriptionHtml: PropertyValue = {
		"@type": "PropertyValue",
		name: "descriptionHtml",
		value: product.descriptionHtml,
	};

	const productTypeValue: PropertyValue = {
		"@type": "PropertyValue",
		name: "productType",
		value: productType,
	};

	const metafields = (product.metafields ?? [])
		.filter(
			(metafield): metafield is NonNullable<typeof metafield> =>
				metafield != null && metafield.key != null && metafield.value != null,
		)
		.map((metafield): PropertyValue => {
			const { key, value, reference, references } = metafield;
			const hasReferenceImage = reference && "image" in reference;
			const referenceImageUrl = hasReferenceImage ? reference.image?.url : null;

			const hasEdges = references?.edges && references.edges.length > 0;
			const edgeImages = hasEdges
				? references!.edges.map((edge) =>
						edge.node && "image" in edge.node ? edge.node.image?.url : null,
					)
				: null;

			const rawValue = referenceImageUrl || edgeImages || value;
			const valueToReturn = Array.isArray(rawValue)
				? JSON.stringify(rawValue)
				: (rawValue ?? undefined);

			return {
				"@type": "PropertyValue",
				name: key,
				value: valueToReturn,
			};
		});

	const additionalProperty: PropertyValue[] = selectedOptions
		.map(toPropertyValue)
		.concat(descriptionHtml)
		.concat(productTypeValue)
		.concat(metafields);

	const skuImages = nonEmptyArray([image]);
	const hasVariant =
		level < 1 && variants.nodes.map((variant) => toProduct(product, variant, url, 1));
	const priceSpec: UnitPriceSpecification[] = [
		{
			"@type": "UnitPriceSpecification",
			priceType: "https://schema.org/SalePrice",
			price: Number(price.amount),
		},
	];

	if (compareAtPrice) {
		priceSpec.push({
			"@type": "UnitPriceSpecification",
			priceType: "https://schema.org/ListPrice",
			price: Number(compareAtPrice.amount),
		});
	}

	const collectionNodes = product.collections?.nodes ?? [];

	return {
		"@type": "Product",
		productID,
		url: `${url.origin}${getPath(product, sku)}`,
		name: sku.title,
		description,
		sku: productID,
		gtin: barcode ?? undefined,
		brand: { "@type": "Brand", name: vendor },
		releaseDate: createdAt,
		additionalProperty,
		isVariantOf: {
			"@type": "ProductGroup",
			productGroupID,
			hasVariant: hasVariant || [],
			url: `${url.origin}${getPath(product)}`,
			name: product.title,
			additionalProperty: [
				...(product.tags ?? []).map((value) => toPropertyValue({ name: "TAG", value })),
				...collectionNodes.map((col) =>
					toPropertyValue({
						"@id": col.id,
						name: "COLLECTION",
						value: col.title,
						valueReference: col.handle,
						description: col.description,
						disambiguatingDescription: col.descriptionHtml,
						...(col.image && {
							image: [
								{
									"@type": "ImageObject" as const,
									encodingFormat: "image",
									alternateName: col.image.altText ?? "",
									url: col.image.url,
								},
							],
						}),
					}),
				),
			],
			image: nonEmptyArray(images.nodes)?.map((img) => ({
				"@type": "ImageObject" as const,
				encodingFormat: "image",
				alternateName: img.altText ?? "",
				url: img.url,
			})),
		},
		image: skuImages?.map((img) => ({
			"@type": "ImageObject" as const,
			encodingFormat: "image",
			alternateName: img?.altText ?? "",
			url: img?.url ?? "",
		})) ?? [DEFAULT_IMAGE],
		video: media.nodes
			.filter((m) => m.mediaContentType === "VIDEO")
			.map((video) => ({
				"@type": "VideoObject" as const,
				contentUrl: video.sources?.[0]?.url,
				description: video.alt ?? undefined,
				thumbnailUrl: video.previewImage?.url,
			})),
		offers: {
			"@type": "AggregateOffer",
			priceCurrency: price.currencyCode,
			highPrice: compareAtPrice ? Number(compareAtPrice.amount) : Number(price.amount),
			lowPrice: Number(price.amount),
			offerCount: 1,
			offers: [
				{
					"@type": "Offer",
					price: Number(price.amount),
					availability: availableForSale
						? "https://schema.org/InStock"
						: "https://schema.org/OutOfStock",
					inventoryLevel: { value: quantityAvailable ?? 0 },
					priceSpecification: priceSpec,
				},
			],
		},
	};
};

const toPropertyValue = (option: Omit<PropertyValue, "@type">): PropertyValue => ({
	"@type": "PropertyValue",
	...option,
});

const isSelectedFilter = (filterValue: FilterValue, url: URL) => {
	let isSelected = false;
	const label = getFilterValue(filterValue);

	url.searchParams.forEach((value, key) => {
		if (!key?.startsWith("filter")) return;
		if (value === label) isSelected = true;
	});
	return isSelected;
};

export const toFilter = (filter: FilterShopify, url: URL): Filter => {
	if (!filter.type.includes("RANGE")) {
		return {
			"@type": "FilterToggle",
			label: filter.label,
			key: filter.id,
			values: filter.values.map((value) => ({
				quantity: value.count,
				label: value.label,
				value: value.label,
				selected: isSelectedFilter(value, url),
				url: filtersURL(filter, value, url),
			})),
			quantity: filter.values.length,
		};
	} else {
		const min = JSON.parse(filter.values[0].input).min;
		const max = JSON.parse(filter.values[0].input).max;
		return {
			"@type": "FilterRange",
			label: filter.label,
			key: filter.id,
			values: { min, max },
		};
	}
};

const filtersURL = (filter: FilterShopify, value: FilterValue, _url: URL) => {
	const url = new URL(_url.href);
	const params = new URLSearchParams(url.search);
	params.delete("page");
	params.delete("startCursor");
	params.delete("endCursor");

	const label = getFilterValue(value);

	if (params.has(filter.id, label)) {
		params.delete(filter.id, label);
	} else {
		params.append(filter.id, label);
	}

	url.search = params.toString();
	return url.toString();
};

const getFilterValue = (value: FilterValue) => {
	try {
		const parsed = JSON.parse(value.input);

		const fieldsToCheck = [
			["productMetafield", "value"],
			["taxonomyMetafield", "value"],
			["productVendor"],
			["productType"],
			["category", "id"],
		];

		for (const path of fieldsToCheck) {
			let current: any = parsed;
			for (const key of path) {
				if (current && typeof current === "object" && key in current) {
					current = current[key];
				} else {
					current = null;
					break;
				}
			}
			if (current != null) return current;
		}
	} catch (error) {
		console.error("Error parsing input JSON:", error);
	}

	return value.label;
};
