/**
 * SWR in-memory fetch cache for VTEX API responses.
 *
 * Inspired by deco-cx/deco runtime/fetch/fetchCache.ts.
 * Provides in-flight deduplication + stale-while-revalidate for GET requests.
 *
 * Only caches on the server side. Keyed by full URL string.
 */

const DEFAULT_MAX_ENTRIES = 500;
const MAX_RETRIES = 2;
const RETRY_DELAYS = [200, 400];
// Per-attempt timeout. Bounds how long a single hung `fetch()` can hold an
// inflight entry alive. Without this, a VTEX subrequest that never settles
// leaks the inflight Map slot forever and every subsequent request for the
// same cache key joins the zombie Promise, pinning memory until
// `exceededMemory` (observed in prod: 514 hard crashes / 24h on a PLP route).
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
	body: unknown;
	status: number;
	createdAt: number;
	refreshing: boolean;
}

const TTL_BY_STATUS: Record<string, number> = {
	"2xx": 180_000, // 3 min for success
	"404": 10_000, // 10s for not found
	"5xx": 0, // never cache server errors
};

function ttlForStatus(status: number): number {
	if (status >= 200 && status < 300) return TTL_BY_STATUS["2xx"];
	if (status === 404) return TTL_BY_STATUS["404"];
	if (status >= 500) return TTL_BY_STATUS["5xx"];
	return 0;
}

const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function evictIfNeeded() {
	if (store.size <= DEFAULT_MAX_ENTRIES) return;
	const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
	const toRemove = sorted.slice(0, store.size - DEFAULT_MAX_ENTRIES);
	for (const [key] of toRemove) store.delete(key);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(response: Response): boolean {
	return response.status >= 500 || response.status === 429;
}

/**
 * Race a Promise against a timeout so callers' `.finally()` always runs.
 * Critical for evicting the inflight Map entry when a `fetch()` hangs —
 * without this, a never-settling Promise leaks the Map slot forever and
 * every subsequent request for the same key joins the zombie Promise.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
	});
	return Promise.race([work, timeout]).finally(() => {
		clearTimeout(timer);
	});
}

async function executeFetch(
	url: string,
	doFetch: () => Promise<Response>,
	retry = true,
): Promise<CacheEntry> {
	let lastError: Error | undefined;

	const attempts = retry ? MAX_RETRIES + 1 : 1;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const response = await doFetch();

			if (isRetryable(response) && attempt < attempts - 1) {
				console.warn(
					`[vtex-fetch] ${response.status} on attempt ${attempt + 1}/${attempts} — ${url}`,
				);
				await sleep(RETRY_DELAYS[attempt] ?? 400);
				continue;
			}

			if (response.status >= 500) {
				throw new Error(
					`fetchWithCache: ${response.status} ${response.statusText} after ${attempt + 1} attempt(s) — ${url}`,
				);
			}

			const body = response.ok ? await response.json() : null;
			return {
				body,
				status: response.status,
				createdAt: Date.now(),
				refreshing: false,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < attempts - 1) {
				console.warn(
					`[vtex-fetch] attempt ${attempt + 1}/${attempts} failed — ${url}: ${lastError.message}`,
				);
				await sleep(RETRY_DELAYS[attempt] ?? 400);
			}
		}
	}

	throw lastError ?? new Error(`fetchWithCache: all ${attempts} attempts failed — ${url}`);
}

export interface FetchCacheOptions {
	/**
	 * Custom TTL in ms. If provided, overrides status-based TTL.
	 */
	ttl?: number;
}

/**
 * Wrap a GET fetch call with SWR caching and in-flight dedup.
 *
 * Returns `null` for non-2xx responses that are cached (e.g. 404).
 * 5xx responses throw so the caller can handle them explicitly.
 *
 * @param cacheKey - Unique key (typically the full URL)
 * @param doFetch - The actual fetch call to execute
 * @param opts - Optional overrides
 * @returns Parsed JSON body, or null for cacheable error responses (e.g. 404)
 */
export function fetchWithCache<T>(
	cacheKey: string,
	doFetch: () => Promise<Response>,
	opts?: FetchCacheOptions,
): Promise<T | null> {
	const now = Date.now();
	const entry = store.get(cacheKey);

	if (entry) {
		const maxAge = opts?.ttl ?? ttlForStatus(entry.status);
		const isStale = now - entry.createdAt > maxAge;

		if (!isStale) return Promise.resolve(entry.body as T | null);

		if (isStale && !entry.refreshing) {
			entry.refreshing = true;
			// Background refresh: no retry — stale data is already being served.
			// Timeout guards against a hung VTEX response leaving `refreshing`
			// stuck true forever (which would silently disable revalidation).
			withTimeout(
				executeFetch(cacheKey, doFetch, false),
				FETCH_TIMEOUT_MS,
				`fetchCache stale-refresh ${cacheKey}`,
			)
				.then((fresh) => {
					const ttl = opts?.ttl ?? ttlForStatus(fresh.status);
					const existingWasSuccess = entry.status >= 200 && entry.status < 300;
					const freshIsError = fresh.status >= 400;
					const wouldDowngrade = existingWasSuccess && freshIsError;
					if (ttl > 0 && !wouldDowngrade) {
						store.set(cacheKey, fresh);
					} else {
						entry.refreshing = false;
					}
				})
				.catch(() => {
					entry.refreshing = false;
				});
			return Promise.resolve(entry.body as T | null);
		}

		return Promise.resolve(entry.body as T | null);
	}

	const existing = inflight.get(cacheKey);
	if (existing) return existing.then((e) => e.body as T | null);

	// Wrap with a timeout so the `.finally()` below always runs and evicts
	// the inflight slot — even if `executeFetch` never settles. See the
	// FETCH_TIMEOUT_MS comment at the top of this file for the leak this
	// guards against.
	const promise = withTimeout(
		executeFetch(cacheKey, doFetch),
		FETCH_TIMEOUT_MS,
		`fetchCache ${cacheKey}`,
	)
		.then((fresh) => {
			const ttl = opts?.ttl ?? ttlForStatus(fresh.status);
			if (ttl > 0) {
				store.set(cacheKey, fresh);
				evictIfNeeded();
			}
			return fresh;
		})
		.finally(() => inflight.delete(cacheKey));

	inflight.set(cacheKey, promise);
	return promise.then((e) => e.body as T | null);
}

export function clearFetchCache() {
	store.clear();
	inflight.clear();
}

export function getFetchCacheStats() {
	return {
		entries: store.size,
		inflight: inflight.size,
	};
}
