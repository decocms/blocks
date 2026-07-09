/**
 * Salesforce Marketing Cloud Personalization (Evergage) app entry.
 *
 * Unlike `magento` / `algolia`, the Salesforce loaders here are
 * stateless — every loader takes its `baseUrl` / `dataset` /
 * `campaignId` / `cookieName` via props so the same package can power
 * multiple Evergage datasets in a single worker without a global
 * configure step. Sites just import the loader(s) they need.
 *
 * For loaders, use sub-path imports:
 *   import list from "@decocms/apps/salesforce/loaders/products/list"
 *   import listRecomended from "@decocms/apps/salesforce/loaders/products/listRecomended"
 *   import listCart from "@decocms/apps/salesforce/loaders/products/listCart"
 *
 * For the transformer (sites typically build their own `propertyMapper`
 * over a dataset's custom columns):
 *   import { createProductTransformer } from "@decocms/apps/salesforce/utils/transform"
 */
export type {
	CampaignResponse,
	ParsedUserCookie,
	PersonalizationBody,
	PersonalizationLineItem,
	PersonalizationResponse,
	SalesforceProduct,
} from "./types";
export { createHttpClient, type HttpClientOptions } from "./utils/httpClient";
export { parseUserCookie } from "./utils/parseUserCookie";
export {
	createProductTransformer,
	type ProductTransformerOptions,
	type PropertyMapper,
} from "./utils/transform";
