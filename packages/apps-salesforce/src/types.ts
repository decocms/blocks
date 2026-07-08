/**
 * Salesforce Marketing Cloud Personalization (Evergage) — request/response
 * shapes for the campaign personalization API.
 *
 * The Evergage product schema is configurable per dataset (each customer
 * chooses which fields to expose), so `SalesforceProduct` keeps a minimal
 * required surface and accepts arbitrary extras via index signature.
 * Site-level transformers can downcast to their own product shape to
 * read store-specific custom fields (e.g. `marca`, `linha`, brand-tags).
 */

export interface SalesforceProduct {
	/** Internal Evergage id (string token, often a SKU or catalog id). */
	id: string;
	/** Display name. */
	name: string;
	/** Base price (list). */
	price: number;
	/** Discounted price; falls back to `price` when no promotion is active. */
	salePrice?: number;
	/** Stock count from Evergage's catalog feed. */
	inventoryCount: number;
	/** Pre-built absolute URLs of product images. */
	imageUrls: string[];
	/** Canonical product URL (full origin + path). */
	url: string;
	/** ISO 4217 currency code (e.g. "BRL"). */
	currency: string;
	/** Common Evergage column — short product description. */
	description?: string;
	/** Optional cross-system identifier (e.g. Magento `entity_id`). */
	idMagento?: string;
	/** Item type tag (e.g. "configurable", "simple"). */
	itemType?: string;
	/** Generic category trail (Evergage stores these as arrays). */
	categories?: string[];
	/** Site-specific extras — Evergage exposes whatever the dataset schema
	 *  defines (e.g. `Marca`, `Volume`, `Linha`, `freeShipping`). The
	 *  product transformer can read these via the attributeMapper hook. */
	[customField: string]: unknown;
}

/**
 * Single line item in a cart-interaction request body. Evergage uses
 * these to seed cart-aware recommendations ("people who bought X also
 * bought Y") and abandoned-cart campaigns.
 */
export interface PersonalizationLineItem {
	catalogObjectType: string;
	catalogObjectId: string;
	quantity: number;
	price: number;
}

/**
 * Body sent to `POST {baseUrl}/api2/event/:dataset`. The Evergage API is
 * "interaction"-based — every request describes an interaction the user
 * had, and the response contains the campaigns triggered by that
 * interaction (recommendations, popups, etc.).
 *
 * `interaction.lineItems` is only used by cart-aware campaigns; PDP /
 * homepage requests omit it. `user.attributes` carries page-context
 * hints (e.g. `viewedProductId` for related-product campaigns).
 */
export interface PersonalizationBody {
	source: {
		channel: string;
		url: string;
	};
	interaction: {
		name: string;
		lineItems?: PersonalizationLineItem[];
	};
	user: {
		anonymousId?: string;
		encryptedId?: string;
		attributes?: Record<string, unknown>;
	};
	flags: {
		nonInteractive: boolean;
		doNotTrack: boolean;
	};
	pageView: boolean;
}

export interface CampaignResponse {
	campaignId: string;
	payload: {
		experience?: string;
		headerText?: string;
		products?: SalesforceProduct[];
		userGroup?: string;
	};
}

export interface PersonalizationResponse {
	campaignResponses?: CampaignResponse[];
}

/**
 * Cookie shape Evergage drops on the browser (`puid` = persistent user
 * id after sign-in, `uuid` = anonymous device id). The site loaders
 * read this cookie to send the right user identifier on each request.
 */
export interface ParsedUserCookie {
	encryptedId?: string;
	anonymousId?: string;
}
