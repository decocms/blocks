/**
 * Wishlist Products loader.
 * Returns a ProductListingPage built from the user's wishlist items.
 *
 * Ported from deco-cx/apps vtex/loaders/product/wishlist.ts
 */
import type { Product, ProductListingPage } from "@decocms/apps-commerce/types";
import { getWishlist } from "./wishlist";

export interface WishlistProductsProps {
	/** Items per page @default 12 */
	count?: number;
	/** 1 to start from index 1 @default 0 */
	offset?: 0 | 1;
	/** The user's auth cookie string */
	authCookie: string;
	/** The user's shopper ID (email) */
	shopperId: string;
	/** Current page URL (for pagination links) */
	url: string;
}

function withPage(baseUrl: string, page: number): string {
	const url = new URL(baseUrl);
	url.searchParams.set("page", `${page}`);
	return `?${url.searchParams}`;
}

export async function wishlistProducts(
	props: WishlistProductsProps,
): Promise<ProductListingPage | null> {
	const { count: recordPerPage = 12, offset = 0, authCookie, shopperId, url: rawUrl } = props;

	const url = new URL(rawUrl);
	const page = Math.max(0, Number(url.searchParams.get("page") ?? offset) - offset);
	const items = await getWishlist(authCookie, { shopperId, allRecords: true });
	const records = items.length;
	const start = page * recordPerPage;
	const end = (page + 1) * recordPerPage;

	const products: Product[] = items
		.map(({ sku, productId }) => ({
			"@type": "Product" as const,
			inProductGroupWithID: productId,
			productID: sku,
			sku,
		}))
		.slice(start, end);

	return {
		"@type": "ProductListingPage",
		breadcrumb: {
			"@type": "BreadcrumbList",
			itemListElement: [],
			numberOfItems: 0,
		},
		filters: [],
		products,
		pageInfo: {
			currentPage: page + offset,
			nextPage: records > end ? withPage(rawUrl, page + 1 + offset) : undefined,
			previousPage: page > 0 ? withPage(rawUrl, page - 1 + offset) : undefined,
			recordPerPage,
			records,
		},
		sortOptions: [],
		seo: null,
	};
}
