/**
 * Cached shipping simulation loader (#373).
 *
 * Wraps `simulateCart` (a POST to `/api/checkout/pub/orderForms/simulation`)
 * with a cache keyed only on the non-personalized inputs — items,
 * postalCode, country, and salesChannel. See `../../utils/simulationCache.ts`
 * for why this can't just be `vtexCachedFetch` (POST + cookie-rotation).
 *
 * On a cache MISS, `simulateCart` still goes through `vtexFetchWithCookies`
 * as normal — cookies rotate exactly as before. Only the response BODY
 * (SLAs + logistics info) is cached; cookies are never stored or replayed.
 */
import { djb2 } from "@decocms/blocks/sdk/djb2";
import { simulateCart, type SimulateCartProps, type SimulationItem } from "../../actions/checkout";
import { getVtexConfig } from "../../client";
import { getSimulationCache } from "../../utils/simulationCache";

/** Shipping SLAs can shift with promotions/stock — keep the TTL short. */
const DEFAULT_TTL_SECONDS = 5 * 60;

export interface ShippingSimulationProps {
	items: SimulationItem[];
	postalCode: string;
	country?: string;
	/** Override the cache TTL (seconds). Defaults to 5 minutes. */
	ttlSeconds?: number;
}

function buildCacheKey(props: ShippingSimulationProps): string {
	const config = getVtexConfig();
	const normalizedItems = [...props.items]
		.map((item) => ({ id: String(item.id), quantity: item.quantity, seller: item.seller }))
		.sort((a, b) => (a.id === b.id ? a.seller.localeCompare(b.seller) : a.id.localeCompare(b.id)));

	const raw = JSON.stringify({
		account: config.account,
		salesChannel: config.salesChannel ?? null,
		items: normalizedItems,
		postalCode: props.postalCode,
		country: props.country ?? config.country ?? "BRA",
	});
	return `shipping-sim:${djb2(raw)}`;
}

/**
 * Fetch shipping SLAs for a cart, serving a cached response body when
 * available for the same `{items, postalCode, salesChannel}` tuple.
 */
export async function getShippingSimulation(props: ShippingSimulationProps): Promise<unknown> {
	const cache = getSimulationCache();
	const key = buildCacheKey(props);

	const cached = await cache.get(key);
	if (cached != null) {
		try {
			return JSON.parse(cached);
		} catch {
			// Corrupted cache entry — fall through to a fresh simulation.
		}
	}

	const simulateProps: SimulateCartProps = {
		items: props.items,
		postalCode: props.postalCode,
		country: props.country,
	};
	const result = await simulateCart(simulateProps);
	await cache.put(key, JSON.stringify(result), props.ttlSeconds ?? DEFAULT_TTL_SECONDS);
	return result;
}
