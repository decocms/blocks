/**
 * Magento newsletter subscribe — POST a customer email to the
 * `/V1/newsletter/subscribed` REST endpoint.
 *
 * Verbatim port of `deco-cx/apps/magento/actions/newsletter/subscribe.ts`:
 * the legacy version took `(props, _req, ctx)` and pulled `storeId` /
 * `clientAdmin` / `site` off the App() context. The TanStack/Node port
 * reads the same fields from `getMagentoConfig()` and uses
 * `magentoFetch` so auth/origin/Referer headers stay aligned with the
 * rest of the magento app. Endpoint shape and request body are
 * unchanged so the Magento backend doesn't need re-tuning.
 */
import { getMagentoConfig, magentoFetch } from "../../client";
import type { NewsletterData } from "../../types";

export interface SubscribeProps {
	/**
	 * @title Email
	 */
	email: string;
}

export default async function subscribe(props: SubscribeProps): Promise<NewsletterData | null> {
	const { site, storeId } = getMagentoConfig();
	const path = `/rest/${encodeURIComponent(site)}/V1/newsletter/subscribed`;

	const res = await magentoFetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: props.email,
			store_id: Number(storeId),
		}),
	});

	if (!res.ok) return null;
	const result = (await res.json()) as NewsletterData | { success: false };
	if (!result || (result as NewsletterData).success === false) return null;
	return result as NewsletterData;
}
