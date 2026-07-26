/**
 * Injectable cache for shipping simulation responses (#373).
 *
 * `simulateCart`'s POST to `/api/checkout/pub/orderForms/simulation` is not
 * user-personalized for a given `{items, postalCode, salesChannel}` tuple —
 * every shopper with the same cart composition and zip code gets the same
 * SLAs — but it goes through `vtexFetchWithCookies` (cookies can rotate on
 * this endpoint), so caching the raw response risks replaying a stale
 * session's cookies onto a different user.
 *
 * This cache stores ONLY the response body (SLAs/logistics info) — never
 * cookies or session state. The default is an in-process Map (works in both
 * `@decocms/tanstack` and `@decocms/nextjs`, no infra required, but is only
 * warm within a single Worker isolate's lifetime). Sites that want a shared
 * edge cache (Cloudflare Cache API, KV) inject their own implementation via
 * `setSimulationCache` — mirrors the `setFastDeployKVGetter` pattern in
 * `@decocms/blocks-admin/src/admin/decofile.ts`.
 */

export interface SimulationCache {
	get(key: string): Promise<string | null> | string | null;
	put(key: string, value: string, ttlSeconds: number): Promise<void> | void;
}

interface InProcessEntry {
	value: string;
	expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 500;

function createInProcessCache(): SimulationCache {
	const store = new Map<string, InProcessEntry>();

	function evictIfNeeded() {
		if (store.size <= DEFAULT_MAX_ENTRIES) return;
		const oldestKey = store.keys().next().value;
		if (oldestKey !== undefined) store.delete(oldestKey);
	}

	return {
		get(key) {
			const entry = store.get(key);
			if (!entry) return null;
			if (Date.now() > entry.expiresAt) {
				store.delete(key);
				return null;
			}
			return entry.value;
		},
		put(key, value, ttlSeconds) {
			store.delete(key); // re-insert for Map's insertion-order-based eviction
			store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
			evictIfNeeded();
		},
	};
}

let cache: SimulationCache = createInProcessCache();

/** Inject a custom simulation cache (e.g. Cloudflare Cache API or KV-backed). */
export function setSimulationCache(custom: SimulationCache): void {
	cache = custom;
}

export function getSimulationCache(): SimulationCache {
	return cache;
}

/** @internal exported for tests */
export function __resetSimulationCacheForTests(): void {
	cache = createInProcessCache();
}
