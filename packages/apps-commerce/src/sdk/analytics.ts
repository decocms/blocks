/**
 * Analytics mappers — convert schema.org Product to GA4 AnalyticsItem.
 *
 * These are the generic, platform-independent mappers. Sites can wrap them
 * to add custom fields (sellerP, etc.) via the `extend` option.
 */
import type { BreadcrumbList, Product } from "../types/commerce";

export interface AnalyticsItem {
	item_id?: string;
	item_name?: string;
	affiliation?: string;
	coupon?: string;
	discount?: number;
	index?: number;
	item_group_id?: string;
	item_url?: string;
	item_brand?: string;
	item_category?: string;
	item_category2?: string;
	item_category3?: string;
	item_category4?: string;
	item_category5?: string;
	item_list_id?: string;
	item_list_name?: string;
	item_variant?: string;
	location_id?: string;
	price?: number;
	quantity: number;
	[key: string]: unknown;
}

export function mapCategoriesToAnalyticsCategories(categories: string[]): Record<string, string> {
	return categories.slice(0, 5).reduce(
		(result, category, index) => {
			result[`item_category${index === 0 ? "" : index + 1}`] = category;
			return result;
		},
		{} as Record<string, string>,
	);
}

export function mapProductCategoryToAnalyticsCategories(category: string): Record<string, string> {
	return category.split(">").reduce(
		(result, cat, index) => {
			result[`item_category${index === 0 ? "" : index}`] = cat.trim();
			return result;
		},
		{} as Record<string, string>,
	);
}

export interface MapProductToAnalyticsItemOptions {
	product: Product;
	breadcrumbList?: BreadcrumbList;
	price?: number;
	lowPrice?: number;
	listPrice?: number;
	index?: number;
	quantity?: number;
	coupon?: string;
	/** Extend the result with custom fields (e.g., sellerP, sellerName) */
	extend?: (product: Product, base: AnalyticsItem) => Record<string, unknown>;
}

export function mapProductToAnalyticsItem(opts: MapProductToAnalyticsItemOptions): AnalyticsItem {
	const {
		product,
		breadcrumbList,
		price,
		lowPrice,
		listPrice,
		index = 0,
		quantity = 1,
		coupon = "",
		extend,
	} = opts;

	const { name, productID, inProductGroupWithID, isVariantOf, url, sku } = product;

	const categories = breadcrumbList?.itemListElement
		? mapCategoriesToAnalyticsCategories(
				breadcrumbList.itemListElement.map(({ name: n }) => n ?? "").filter(Boolean),
			)
		: mapProductCategoryToAnalyticsCategories(product.category ?? "");

	const base: AnalyticsItem = {
		item_id: productID,
		item_group_id: inProductGroupWithID,
		quantity,
		coupon,
		price: lowPrice,
		index,
		item_variant: sku,
		discount: Number((price && listPrice ? listPrice - price : 0).toFixed(2)),
		item_name: isVariantOf?.name ?? name ?? "",
		item_brand: product.brand?.name ?? "",
		item_url: url,
		...categories,
	};

	if (extend) {
		return { ...base, ...extend(product, base) };
	}

	return base;
}

export interface MapProductToAnalyticsItemListOptions {
	product: Product;
	breadcrumbList?: BreadcrumbList;
	price?: number;
	listPrice?: number;
	index?: number;
	quantity?: number;
	coupon?: string;
}

export function mapProductToAnalyticsItemList(
	opts: MapProductToAnalyticsItemListOptions,
): AnalyticsItem {
	const { product, breadcrumbList, price, listPrice, index = 0, quantity = 1, coupon = "" } = opts;

	const { name, productID, inProductGroupWithID, isVariantOf, url } = product;

	const categories = breadcrumbList?.itemListElement
		? mapCategoriesToAnalyticsCategories(
				breadcrumbList.itemListElement.map(({ name: n }) => n ?? "").filter(Boolean),
			)
		: mapProductCategoryToAnalyticsCategories(product.category ?? "");

	const finalPrice = typeof price === "number" ? price : 0;
	const discount =
		typeof listPrice === "number" && typeof price === "number" ? Math.max(0, listPrice - price) : 0;

	const itemId = inProductGroupWithID ?? isVariantOf?.productGroupID ?? productID;

	return {
		item_id: itemId,
		item_group_id: inProductGroupWithID,
		quantity,
		coupon,
		price: finalPrice,
		index,
		discount: Number(discount.toFixed(2)),
		item_name: isVariantOf?.name ?? name ?? "",
		item_brand: product.brand?.name ?? "",
		item_url: url,
		...categories,
	};
}
