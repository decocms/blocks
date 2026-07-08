/**
 * VTEX Logistics & Sales-Channel API loaders.
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/logistics/getSalesChannelById.ts
 *   vtex/loaders/logistics/listPickupPoints.ts
 *   vtex/loaders/logistics/listPickupPointsByLocation.ts
 *   vtex/loaders/logistics/listSalesChannelById.ts  (actually lists all)
 *   vtex/loaders/logistics/listStockByStore.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/logistics-api
 */
import { vtexFetch } from "../client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductBalance {
	warehouseId: string;
	warehouseName: string;
	totalQuantity: number;
	reservedQuantity: number;
	hasUnlimitedQuantity: boolean;
}

export interface PickupPointsByLocationOpts {
	geoCoordinates?: number[];
	postalCode?: string;
	countryCode?: string;
}

export interface PickupPointsResponse<T = any> {
	paging: { page: number; pageSize: number; total: number; pages: number };
	items: Array<{ distance: number; pickupPoint: T }>;
}

// ---------------------------------------------------------------------------
// Sales Channels
// ---------------------------------------------------------------------------

/**
 * Get a single sales channel by ID (public API).
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/saleschannel/-salesChannelId-
 */
export async function getSalesChannelById<T = any>(id: string): Promise<T> {
	return vtexFetch<T>(`/api/catalog_system/pub/saleschannel/${id}`);
}

/**
 * List all sales channels (private API — requires appKey/appToken).
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pvt/saleschannel/list
 */
export async function listSalesChannels<T = any>(): Promise<T[]> {
	return vtexFetch<T[]>("/api/catalog_system/pvt/saleschannel/list");
}

// ---------------------------------------------------------------------------
// Pickup Points
// ---------------------------------------------------------------------------

/**
 * List all configured pickup points (private API — requires appKey/appToken).
 * @see https://developers.vtex.com/docs/api-reference/logistics-api#get-/api/logistics/pvt/configuration/pickuppoints
 */
export async function listPickupPoints<T = any>(): Promise<T[]> {
	return vtexFetch<T[]>("/api/logistics/pvt/configuration/pickuppoints");
}

/**
 * Search pickup points near a geographic location (public API).
 * Pass either `geoCoordinates` (lon/lat array) **or** `postalCode` + `countryCode`.
 *
 * @see https://developers.vtex.com/docs/api-reference/checkout-api#get-/api/checkout/pub/pickup-points
 */
export async function listPickupPointsByLocation<T = any>(
	opts: PickupPointsByLocationOpts,
): Promise<PickupPointsResponse<T>> {
	const params = new URLSearchParams();
	if (opts.geoCoordinates) {
		params.set("geoCoordinates", opts.geoCoordinates.join(","));
	} else {
		if (opts.postalCode) params.set("postalCode", opts.postalCode);
		if (opts.countryCode) params.set("countryCode", opts.countryCode);
	}

	return vtexFetch<PickupPointsResponse<T>>(`/api/checkout/pub/pickup-points?${params}`);
}

// ---------------------------------------------------------------------------
// Stock / Inventory
// ---------------------------------------------------------------------------

/**
 * List inventory balances for a SKU across all warehouses.
 * @see https://developers.vtex.com/docs/api-reference/logistics-api#get-/api/logistics/pvt/inventory/skus/-skuId-
 */
export async function listStockByStore(skuId: number): Promise<ProductBalance[]> {
	try {
		const result = await vtexFetch<{
			skuId?: string;
			balance?: ProductBalance[];
		}>(`/api/logistics/pvt/inventory/skus/${skuId}`);

		return result.balance ?? [];
	} catch (error) {
		console.error("[listStockByStore]", error);
		return [];
	}
}
