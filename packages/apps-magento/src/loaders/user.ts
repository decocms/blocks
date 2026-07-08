/**
 * Resolves the current customer into a schema.org `Person` from
 * Magento's `/customer/section/load?sections=customer,carbono-customer`
 * endpoint, scoped by the visitor's PHPSESSID cookie.
 *
 * Ported from `deco-cx/apps/magento/loaders/user.ts`. The Fresh
 * version used `clientAdmin["GET /:site/customer/section/load"]` with
 * typed indexed routes — the TanStack/Node port uses `magentoFetch`
 * (which already applies auth/origin headers for same-origin) plus an
 * explicit `Cookie: PHPSESSID=…` header so Magento associates the
 * request with the logged-in customer.
 *
 * Returns null when:
 *  - the session cookie is absent (anonymous visitor — expected),
 *  - the customer slice is missing or has no data_id (Magento returns
 *    {} for guest sessions),
 *  - the HTTP call throws or returns a non-2xx (defensive — the
 *    storefront just renders the logged-out UI).
 */
import type { Person } from "@decocms/apps-commerce/types";
import { getMagentoConfig, magentoFetch } from "../client";
import type { CustomerSectionLoad } from "../utils/client/types";
import { SESSION_COOKIE } from "../utils/constants";
import { getUserCookie } from "../utils/user";

export default async function user(_props: unknown, req: Request): Promise<Person | null> {
	const sessionId = getUserCookie(req.headers);
	if (!sessionId) return null;

	const { site } = getMagentoConfig();
	const path = `/${encodeURIComponent(site)}/customer/section/load?sections=customer,carbono-customer`;

	try {
		const res = await magentoFetch(path, {
			headers: { Cookie: `${SESSION_COOKIE}=${sessionId}` },
		});
		if (!res.ok) return null;

		const response = (await res.json()) as CustomerSectionLoad;
		const carbono = response["carbono-customer"];
		const customer = response.customer;

		if (!carbono?.data_id || !customer) return null;

		const { customerId, email } = carbono;
		const { fullname, firstname } = customer;

		return {
			"@id": customerId,
			email: email,
			givenName: firstname,
			...(firstname &&
				fullname && {
					familyName: fullname.replace(firstname, "").trim(),
				}),
		};
	} catch {
		return null;
	}
}
