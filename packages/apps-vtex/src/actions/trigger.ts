/**
 * VTEX SKU change notification (trigger/webhook) types.
 *
 * Ported from `vtex/_to-port/actions/trigger.ts`.
 * The original Deco action forwarded the payload to a Durable Object workflow.
 * Actual webhook handling is framework-specific, so we only export the
 * canonical payload interface and a handler signature type here.
 */

/** Payload sent by VTEX when a SKU changes in the catalog. */
export interface VTEXNotificationPayload {
	/** SKU ID in VTEX. */
	IdSku: string;
	/** Seller's account name in VTEX (visible in the store's Admin URL). */
	An: string;
	/** Affiliate ID generated automatically in the configuration. */
	IdAffiliate: string;
	/** Product ID in VTEX. */
	ProductId: number;
	/** Date when the item was updated. */
	DateModified: string;
	/**
	 * Whether the product is active. `false` means the product was
	 * deactivated and should be blocked / zeroed in the marketplace.
	 */
	IsActive: boolean;
	/** Inventory level has changed -- run a Fulfillment Simulation to refresh. */
	StockModified: boolean;
	/** Price has changed -- run a Fulfillment Simulation to refresh. */
	PriceModified: boolean;
	/** Product/SKU registration data changed (name, description, weight, etc.). */
	HasStockKeepingUnitModified: boolean;
	/** Product is no longer associated with the trade policy. */
	HasStockKeepingUnitRemovedFromAffiliate: boolean;
}

/**
 * Generic handler signature for the VTEX trigger webhook.
 * Implement this in your framework layer (e.g. TanStack Start API route).
 */
export type VTEXTriggerHandler = (
	payload: VTEXNotificationPayload,
) => Promise<{ id: string } | undefined>;
