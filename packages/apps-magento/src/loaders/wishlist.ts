/**
 * Resolves the visitor's saved wishlist via Magento's
 * `/customer/section/load?sections=wishlist` endpoint, scoped by the
 * PHPSESSID cookie.
 *
 * Ported from `deco-cx/apps/magento/loaders/wishlist.ts`. Returns null
 * when the session cookie is absent or Magento reports no wishlist
 * (e.g. a logged-in customer who never saved an item).
 */
import { getMagentoConfig, magentoFetch } from "../client";
import type { CustomerSectionLoad, Wishlist } from "../utils/client/types";
import { SESSION_COOKIE } from "../utils/constants";
import { getUserCookie } from "../utils/user";

export default async function wishlist(_props: unknown, req: Request): Promise<Wishlist | null> {
	const sessionId = getUserCookie(req.headers);
	if (!sessionId) return null;

	const { site } = getMagentoConfig();
	const path = `/${encodeURIComponent(site)}/customer/section/load?sections=wishlist`;

	const res = await magentoFetch(path, {
		headers: { Cookie: `${SESSION_COOKIE}=${sessionId}` },
	});
	if (!res.ok) return null;

	const { wishlist } = (await res.json()) as CustomerSectionLoad;
	return wishlist ?? null;
}
