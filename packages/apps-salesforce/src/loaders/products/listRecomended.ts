/**
 * Salesforce Marketing Cloud Personalization — recommendations loader.
 *
 * Same wire format as `list.ts`, but the campaign Evergage runs is the
 * "related products" one and the request body includes the
 * `viewedProductId` attribute so Evergage can use the in-context PDP
 * to seed its recommendation model.
 *
 * Used on PDP / PDC pages; the upstream site passes the resolved
 * `ProductDetailsPage` so we can read `product.sku`. When no product
 * context is available the loader still sends the campaign request —
 * Evergage will return its default fallback list.
 */
import type { Product, ProductDetailsPage } from "@decocms/apps-commerce/types";
import type { CampaignResponse, PersonalizationResponse, SalesforceProduct } from "../../types";
import { createHttpClient } from "../../utils/httpClient";
import { parseUserCookie } from "../../utils/parseUserCookie";
import { createProductTransformer, type PropertyMapper } from "../../utils/transform";

export interface SalesforceListRecommendedProps {
	/** @title Product Id (resolved PDP) */
	productId: ProductDetailsPage | null;
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
	/** Custom property mapper. */
	propertyMapper?: PropertyMapper;
}

export interface SalesforceListRecommendedResult {
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

export default async function salesforceListRecommendedLoader(
	props: SalesforceListRecommendedProps,
	_req?: Request,
): Promise<SalesforceListRecommendedResult | null> {
	const { baseUrl, dataset, productId, cookieName, campaignId, currencyCode, propertyMapper } =
		props;

	try {
		const rawCookie = await readCookie(cookieName);
		const userData = parseUserCookie(rawCookie);

		const client = createHttpClient({
			base: baseUrl,
			headers: { "x-requested-with": "XMLHttpRequest" },
		});

		const requestBody = {
			source: { channel: "WebServer", url: `mcp_campaign=${campaignId}` },
			interaction: { name: "Personalization Campaigns" },
			user: {
				...userData,
				attributes: { viewedProductId: productId?.product?.sku ?? "" },
			},
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
		console.error("[salesforce/products/listRecomended] failed:", (err as Error)?.message);
		return null;
	}
}
