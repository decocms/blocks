/**
 * Salesforce Marketing Cloud Personalization — cart-aware recommendations.
 *
 * Same wire format as `list.ts`, but the interaction name is
 * `"Replace Cart"` and the request body carries the current cart's line
 * items so Evergage can seed cross-sell / "frequently bought together"
 * campaigns from the items already in the basket.
 *
 * Sites typically call this loader from a "cart drawer" / "cart side panel"
 * section. The cart state itself isn't read from cookies here — sites
 * resolve their own cart (Magento, Shopify, custom) and pass `items` as
 * a flat array. When `items` is empty, the loader short-circuits and
 * returns `null` (no cart → no cross-sell).
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

export interface SalesforceListCartItem {
	sku: string;
	qty: number;
	price: number;
}

export interface SalesforceListCartProps {
	/**
	 * @title Cart Items
	 * @description Items currently in the user's cart. Site loaders resolve
	 *   this from their commerce backend (Magento, Shopify, etc.) and pass
	 *   it through.
	 */
	items: SalesforceListCartItem[];
	/** @title Personalization Base URL */
	baseUrl: string;
	/** @title Personalization Dataset */
	dataset: string;
	/** @title Campaign Id */
	campaignId: string;
	/** @title Cookie Name */
	cookieName: string;
	/** @title Currency Code (ISO 4217) */
	currencyCode?: string;
	/**
	 * @title Fallback Title
	 * @description Shown when the campaign payload has no `headerText`
	 *   (e.g. Granado uses the configured `label` from the CMS block).
	 */
	title?: string;
	/** Custom property mapper. */
	propertyMapper?: PropertyMapper;
}

export interface SalesforceListCartResult {
	"@type": "ProductList";
	list: Product[];
	additionalData: {
		title?: string;
		campaignId: string;
		experienceId?: string;
		userGroup?: string;
	};
}

async function readCookie(cookieName: string): Promise<string | undefined> {
	try {
		const { getCookies } = await import("@tanstack/react-start/server");
		const cookies = getCookies();
		return cookies?.[cookieName];
	} catch {
		return undefined;
	}
}

export default async function salesforceListCartLoader(
	props: SalesforceListCartProps,
	_req?: Request,
): Promise<SalesforceListCartResult | null> {
	const { items, baseUrl, dataset, campaignId, cookieName, currencyCode, title, propertyMapper } =
		props;

	if (!items?.length) return null;

	try {
		const rawCookie = await readCookie(cookieName);
		const userData = parseUserCookie(rawCookie);

		const client = createHttpClient({
			base: baseUrl,
			headers: { "x-requested-with": "XMLHttpRequest" },
		});

		const requestBody: PersonalizationBody = {
			source: { channel: "WebServer", url: `mcp_campaign=${campaignId}` },
			interaction: {
				name: "Replace Cart",
				lineItems: items.map(({ sku, qty, price }) => ({
					catalogObjectType: "Product",
					catalogObjectId: sku,
					quantity: qty,
					price,
				})),
			},
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
				title: payload.headerText || title,
				campaignId,
				experienceId: payload.experience,
				userGroup: payload.userGroup,
			},
		};
	} catch (err) {
		console.error("[salesforce/products/listCart] failed:", (err as Error)?.message);
		return null;
	}
}
