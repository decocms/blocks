/**
 * Salesforce Marketing Cloud Personalization (formerly Evergage): request and
 * response shapes of the Event API (`POST /api2/event/{dataset}`).
 *
 * Product fields are configured per dataset, so `PersonalizationProduct`
 * keeps the common fields and accepts whatever else the dataset exposes.
 */

export interface PersonalizationProduct {
  id: string;
  name: string;
  /** List price. */
  price: number;
  /** Promotional price, when one is active. */
  salePrice?: number;
  inventoryCount: number;
  imageUrls: string[];
  /** Absolute product URL. */
  url: string;
  /** ISO 4217 currency code. */
  currency: string;
  description?: string;
  itemType?: string;
  categories?: string[];
  /** Whatever else the dataset's catalog schema defines. */
  [customField: string]: unknown;
}

/** A cart line, sent with cart-aware interactions. */
export interface PersonalizationLineItem {
  catalogObjectType: string;
  catalogObjectId: string;
  quantity: number;
  price: number;
}

/** The interaction a shopper had; the response holds the campaigns it triggered. */
export interface PersonalizationEvent {
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
  flags?: {
    nonInteractive?: boolean;
    doNotTrack?: boolean;
  };
  pageView?: boolean;
}

export interface CampaignResponse {
  campaignId: string;
  payload: {
    experience?: string;
    headerText?: string;
    products?: PersonalizationProduct[];
    userGroup?: string;
    [field: string]: unknown;
  };
}

export interface PersonalizationResponse {
  campaignResponses?: CampaignResponse[];
}
