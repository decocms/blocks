/**
 * Adds a product to the customer's wishlist and returns the refreshed
 * wishlist on success (or null on failure).
 *
 * Ported from `deco-cx/apps/magento/actions/wishlist/addItem.ts`. The
 * Fresh version posted multipart FormData with `product` + `form_key`
 * to `/wishlist/index/add/` and on success delegated to
 * wishlistLoader to fetch the updated state. Same flow here — but the
 * wishlistLoader is imported from the upstream port instead of the
 * legacy in-site path.
 */
import { getCookies } from "@decocms/blocks/sdk/cookie";
import { getMagentoConfig, magentoFetch } from "../../client";
import wishlistLoader from "../../loaders/wishlist";
import type { Wishlist } from "../../utils/client/types";
import { FORM_KEY_COOKIE, SESSION_COOKIE } from "../../utils/constants";
import { getUserCookie } from "../../utils/user";

export interface AddWishlistItemProps {
	productId: string;
}

export default async function addItem(
	{ productId }: AddWishlistItemProps,
	req: Request,
): Promise<Wishlist | null> {
	try {
		const sessionId = getUserCookie(req.headers);
		if (!sessionId) return null;

		const cookies = getCookies(req.headers);
		const formKey = cookies[FORM_KEY_COOKIE];
		if (!formKey) return null;

		const { site } = getMagentoConfig();
		const body = new FormData();
		body.append("product", productId);
		body.append("form_key", formKey);

		const res = await magentoFetch(`/${encodeURIComponent(site)}/wishlist/index/add/`, {
			method: "POST",
			headers: {
				Cookie: `${SESSION_COOKIE}=${sessionId}`,
				"x-requested-with": "XMLHttpRequest",
			},
			body,
		});

		if (!res.ok) return null;
		const { success } = (await res.json()) as { success?: boolean };
		if (!success) return null;

		return wishlistLoader(null, req);
	} catch {
		return null;
	}
}
