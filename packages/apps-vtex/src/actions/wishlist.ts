/**
 * VTEX Wishlist actions (wish-list graphql app).
 * Ported from deco-cx/apps:
 *   - vtex/actions/wishlist/addItem.ts
 *   - vtex/actions/wishlist/removeItem.ts
 * @see https://developers.vtex.com/docs/apps/vtex.wish-list
 */
import { getVtexConfig, vtexIOGraphQL } from "../client";
import { buildAuthCookieHeader } from "../utils/vtexId";

/** Maximum wishlist items to fetch in a single query. */
const WISHLIST_MAX_ITEMS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WishlistItem {
	id?: string;
	productId: string;
	sku: string;
	title?: string;
}

// ---------------------------------------------------------------------------
// GraphQL helper (myvtex.com private graphql)
// ---------------------------------------------------------------------------

function buildCookieHeader(authCookie: string): string {
	return buildAuthCookieHeader(authCookie, getVtexConfig().account);
}

// ---------------------------------------------------------------------------
// Queries & Mutations
// ---------------------------------------------------------------------------

const ADD_TO_WISHLIST = `mutation AddToWishlist($listItem: ListItemInputType!, $shopperId: String!, $name: String!, $public: Boolean) {
  addToList(listItem: $listItem, shopperId: $shopperId, name: $name, public: $public) @context(provider: "vtex.wish-list@1.x")
}`;

const REMOVE_FROM_WISHLIST = `mutation RemoveFromList($id: ID!, $shopperId: String!, $name: String) {
  removeFromList(id: $id, shopperId: $shopperId, name: $name) @context(provider: "vtex.wish-list@1.x")
}`;

const VIEW_WISHLIST = `query ViewList($shopperId: String!, $name: String!, $from: Int!, $to: Int!) {
  viewList(shopperId: $shopperId, name: $name, from: $from, to: $to) @context(provider: "vtex.wish-list@1.x") {
    data { id productId sku title }
  }
}`;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function fetchWishlist(shopperId: string, authCookie: string): Promise<WishlistItem[]> {
	const data = await vtexIOGraphQL<{
		viewList: { data: WishlistItem[] | null };
	}>(
		{
			query: VIEW_WISHLIST,
			variables: { shopperId, name: "Wishlist", from: 0, to: WISHLIST_MAX_ITEMS },
		},
		{ Cookie: buildCookieHeader(authCookie) },
	);
	return data.viewList?.data ?? [];
}

/**
 * Add an item to the user's wishlist.
 * Returns the updated full wishlist.
 */
export async function addItem(
	item: { productId: string; sku: string; title?: string },
	shopperId: string,
	authCookie: string,
): Promise<WishlistItem[]> {
	if (!authCookie) throw new Error("User must be logged in to add to wishlist");
	await vtexIOGraphQL<unknown>(
		{
			query: ADD_TO_WISHLIST,
			variables: {
				name: "Wishlist",
				shopperId,
				listItem: item,
			},
		},
		{ Cookie: buildCookieHeader(authCookie) },
	);
	return fetchWishlist(shopperId, authCookie);
}

/**
 * Remove an item from the user's wishlist by its list-entry ID.
 * Returns the updated full wishlist.
 */
export async function removeItem(
	id: string,
	shopperId: string,
	authCookie: string,
): Promise<WishlistItem[]> {
	if (!authCookie) throw new Error("User must be logged in to remove from wishlist");
	await vtexIOGraphQL<unknown>(
		{
			query: REMOVE_FROM_WISHLIST,
			variables: {
				id,
				name: "Wishlist",
				shopperId,
			},
		},
		{ Cookie: buildCookieHeader(authCookie) },
	);
	return fetchWishlist(shopperId, authCookie);
}
