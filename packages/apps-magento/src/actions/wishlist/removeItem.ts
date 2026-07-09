/**
 * Removes a wishlist item by its Magento item id and returns the
 * refreshed wishlist on success (or null on failure).
 *
 * Ported from `deco-cx/apps/magento/actions/wishlist/removeItem.ts`.
 * The legacy code also passed an empty `uenc=""` form param — kept
 * here byte-for-byte because Magento's wishlist controller treats the
 * absence of `uenc` differently from an empty value and we don't want
 * a silent behavior shift.
 */
import { getCookies } from "@decocms/blocks/sdk/cookie";
import { getMagentoConfig, magentoFetch } from "../../client";
import wishlistLoader from "../../loaders/wishlist";
import type { Wishlist } from "../../utils/client/types";
import { FORM_KEY_COOKIE, SESSION_COOKIE } from "../../utils/constants";
import { getUserCookie } from "../../utils/user";

export interface RemoveWishlistItemProps {
	/** Magento wishlist item id (NOT the product id — the wishlist row id) */
	productId: string;
}

export default async function removeItem(
	{ productId }: RemoveWishlistItemProps,
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
		body.append("item", productId);
		body.append("uenc", "");
		body.append("form_key", formKey);

		const res = await magentoFetch(`/${encodeURIComponent(site)}/wishlist/index/remove/`, {
			method: "POST",
			headers: {
				Cookie: `${SESSION_COOKIE}=${sessionId}`,
				"x-requested-with": "XMLHttpRequest",
				"Content-Type": "application/x-www-form-urlencoded",
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
