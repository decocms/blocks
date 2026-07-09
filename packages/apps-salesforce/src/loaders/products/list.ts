/**
 * Salesforce Marketing Cloud Personalization — campaign list loader.
 *
 * Hits `POST {baseUrl}/api2/event/:dataset` with the user identifier
 * extracted from the Evergage cookie and returns the products attached
 * to the matching campaign payload. When no cookie exists (first visit
 * / parity bot / SSR), `parseUserCookie` falls back to the literal
 * `anonymous` so Evergage still responds with a default campaign
 * instead of erroring.
 *
 * Cookies are read via `getCookies()` from `@tanstack/react-start/server`
 * — the request object isn't propagated through the framework's
 * `commerceLoader(resolvedProps)` call, so we rely on AsyncLocalStorage
 * to recover the original request from inside the deferred section
 * server function context.
 */
import type { Product } from "@decocms/apps-commerce/types";
import type {
	CampaignResponse,
	PersonalizationBody,
	PersonalizationResponse,
	SalesforceProduct,
} from "../../types";
import { createHttpClient } from "../../utils/httpClient";
import { parseUserCookie } from "../../utils/parseUserCookie";
import { createProductTransformer, type PropertyMapper } from "../../utils/transform";

export interface SalesforceListLoaderProps {
	/**
	 * @title Personalization Base URL
	 * @description e.g. `https://<account>.us-5.evergage.com`
	 */
	baseUrl: string;
	/** @title Personalization Dataset */
	dataset: string;
	/** @title Campaign Id */
	campaignId: string;
	/**
	 * @title Cookie Name
	 * @description Cookie name Evergage drops on the browser
	 *   (e.g. `_evga_<accountSlug>`)
	 */
	cookieName: string;
	/** @title Currency Code (ISO 4217) */
	currencyCode?: string;
	/** Custom property mapper passed by site wrappers. */
	propertyMapper?: PropertyMapper;
}

export interface SalesforceListResult {
	"@type": "ProductList";
	list: Product[];
	additionalData: {
		title?: string;
		campaignId: string;
		experienceId?: string;
		userGroup?: string;
	};
}

/**
 * Read the named cookie from the in-flight request. Imported lazily so
 * the loader stays runtime-agnostic for unit tests (a manual cookie
 * value can be passed via `__testCookieOverride`).
 */
async function readCookie(cookieName: string): Promise<string | undefined> {
	try {
		const { getCookies } = await import("@tanstack/react-start/server");
		const cookies = getCookies();
		return cookies?.[cookieName];
	} catch {
		return undefined;
	}
}

export default async function salesforceListLoader(
	props: SalesforceListLoaderProps,
	_req?: Request,
): Promise<SalesforceListResult | null> {
	const { baseUrl, dataset, campaignId, cookieName, currencyCode, propertyMapper } = props;

	try {
		const rawCookie = await readCookie(cookieName);
		const userData = parseUserCookie(rawCookie);

		const client = createHttpClient({
			base: baseUrl,
			headers: { "x-requested-with": "XMLHttpRequest" },
		});

		const requestBody: PersonalizationBody = {
			source: { channel: "WebServer", url: `mcp_campaign=${campaignId}` },
			interaction: { name: "Personalization Campaigns" },
			user: userData,
			flags: { nonInteractive: true, doNotTrack: false },
			pageView: false,
		};

		const response = (await client["POST /api2/event/:dataset"](
			{ dataset },
			{ body: requestBody },
		).then((res: { json: () => Promise<PersonalizationResponse> }) =>
			res.json(),
		)) as PersonalizationResponse;

		const payload =
			response.campaignResponses?.find((item: CampaignResponse) => item.campaignId === campaignId)
				?.payload ?? response.campaignResponses?.[0]?.payload;

		if (!payload?.products?.length) {
			return null;
		}

		const transform = createProductTransformer({ propertyMapper });

		return {
			"@type": "ProductList",
			list: payload.products.map((product: SalesforceProduct) =>
				transform({
					product,
					options: { currencyCode: currencyCode ?? product.currency },
				}),
			),
			additionalData: {
				title: payload.headerText,
				campaignId,
				experienceId: payload.experience,
				userGroup: payload.userGroup,
			},
		};
	} catch (err) {
		// The legacy Deno loader swallowed errors and returned null. We
		// keep the same return shape (so consumers don't have to handle
		// rejections) but log the failure — silent null hides API outages
		// and CORS regressions during parity validation.
		console.error("[salesforce/products/list] failed:", (err as Error)?.message);
		return null;
	}
}
