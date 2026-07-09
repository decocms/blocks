/**
 * VTEX Wishlist API loader.
 * Pure async function — requires configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/wishlist.ts
 *
 * @see https://developers.vtex.com/docs/guides/vtex-wish-list
 */
import { vtexIOGraphQL } from "../client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WishlistItem {
	id: string;
	productId: string;
	sku: string;
	title: string;
}

export interface GetWishlistOpts {
	shopperId: string;
	count?: number;
	page?: number;
	allRecords?: boolean;
}

// ---------------------------------------------------------------------------
// getWishlist (authenticated — VTEX IO GraphQL)
// ---------------------------------------------------------------------------

const WISHLIST_QUERY = `query GetWishlist($shopperId: String!, $name: String!, $from: Int, $to: Int) {
  viewList(shopperId: $shopperId, name: $name, from: $from, to: $to)
    @context(provider: "vtex.wish-list@1.x") {
    name
    data {
      id
      productId
      sku
      title
    }
  }
}`;

/**
 * Fetch the wishlist for a given shopper.
 * Requires a valid VTEX auth cookie.
 *
 * @param authCookie - Raw `cookie` header value from the user request.
 * @param opts.shopperId - The shopper identifier (usually the e-mail from the JWT `sub` claim).
 * @param opts.count - Items per page (default: all).
 * @param opts.page - Zero-based page index (default: 0).
 * @param opts.allRecords - When true, ignores pagination and returns every item.
 */
export async function getWishlist(
	authCookie: string,
	opts: GetWishlistOpts,
): Promise<WishlistItem[]> {
	try {
		const { viewList } = await vtexIOGraphQL<{
			viewList: { name?: string; data: WishlistItem[] };
		}>(
			{
				operationName: "GetWishlist",
				query: WISHLIST_QUERY,
				variables: {
					name: "Wishlist",
					shopperId: opts.shopperId,
				},
			},
			{ cookie: authCookie },
		);

		const data = viewList.data ?? [];

		if (opts.allRecords) return data;

		const count = opts.count ?? Infinity;
		const page = opts.page ?? 0;
		return data.slice(count * page, count * (page + 1));
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}
		return [];
	}
}
