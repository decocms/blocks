/**
 * Regression tests for the auto-forwarding of `vtex_segment` on outgoing
 * VTEX API calls. Without this, Legacy Catalog endpoints don't see the
 * region cookie and return OutOfStock for products only available
 * through regional sellers — see vtex/client.ts:vtexFetchResponse.
 */

import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configureVtex,
	intelligentSearch,
	setVtexFetch,
	vtexCachedFetch,
	vtexFetchResponse,
} from "../client";
import { clearFetchCache } from "../utils/fetchCache";

function mockResponse(body: unknown = {}, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		json: () => Promise.resolve(body),
	} as Response;
}

/**
 * Run `fn` inside a fake request context with the given cookie header.
 *
 * Two problems prevented a naive `RequestContext.run(new Request(...))`
 * approach from working:
 *
 *  1. Under the Fetch spec a Request's headers are in the "request"
 *     guard mode, which silently drops forbidden request headers —
 *     including `cookie` — at construction time. Node 22 / undici
 *     enforces this strictly, so the cookie never reaches
 *     `request.headers.get("cookie")`.
 *  2. `@decocms/start`'s `RequestContext` is backed by a
 *     `RequestStore` that defaults to a NOOP implementation. The
 *     ALS-backed store is installed by site code at worker boot, not
 *     in unit tests. So `RequestContext.run(req, fn)` calls
 *     `fn()` without any propagation, and `RequestContext.current`
 *     inside `fn` still returns `null` — production code under test
 *     never sees the test's cookie.
 *
 * Fix: build a fresh `Headers` object (which uses the "none" guard,
 * so `set("cookie", ...)` works), wrap it in a minimal `Ctx`-shaped
 * object, and override the `RequestContext.current` getter via
 * `vi.spyOn`. The spy is restored after `fn` resolves to keep tests
 * isolated. Nothing here depends on undici or ALS internals.
 */
/**
 * Read a header from an init in a shape-agnostic way. After the
 * `mergeHeaders` refactor, `init.headers` is always a `Headers`
 * instance — but the helper handles legacy shapes too so the tests
 * stay robust if someone changes the merge implementation again.
 */
function headerValue(init: RequestInit | undefined, name: string): string | undefined {
	const headers = init?.headers;
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (Array.isArray(headers)) {
		const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
		return found?.[1];
	}
	const rec = headers as Record<string, string>;
	const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
	return key ? rec[key] : undefined;
}

function withRequest<T>(cookieHeader: string | null, fn: () => Promise<T>): Promise<T> {
	const headers = new Headers();
	if (cookieHeader) headers.set("cookie", cookieHeader);
	const fakeCtx = {
		request: { headers } as unknown as Request,
		signal: new AbortController().signal,
		responseHeaders: new Headers(),
		bag: new Map(),
		startedAt: Date.now(),
	};
	const spy = vi
		.spyOn(RequestContext, "current", "get")
		.mockReturnValue(fakeCtx as unknown as ReturnType<typeof Reflect.get>);
	return fn().finally(() => spy.mockRestore());
}

describe("vtexFetchResponse — vtex_segment cookie forwarding", () => {
	let lastInit: RequestInit | undefined;

	beforeEach(() => {
		configureVtex({ account: "testaccount" });
		lastInit = undefined;
		setVtexFetch(((_url: string, init?: RequestInit) => {
			lastInit = init;
			return Promise.resolve(mockResponse());
		}) as typeof fetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards vtex_segment cookie when present and caller didn't set one", async () => {
		await withRequest("vtex_segment=abc123; other=foo", async () => {
			await vtexFetchResponse("/api/catalog_system/pub/products/x");
		});
		expect(headerValue(lastInit, "cookie")).toBe("vtex_segment=abc123");
	});

	it("does not overwrite a caller-supplied cookie header", async () => {
		await withRequest("vtex_segment=abc123", async () => {
			await vtexFetchResponse("/api/x", {
				headers: { cookie: "custom=zzz" },
			});
		});
		expect(headerValue(lastInit, "cookie")).toBe("custom=zzz");
	});

	it("does not overwrite a caller-supplied Cookie header (case-insensitive)", async () => {
		await withRequest("vtex_segment=abc123", async () => {
			await vtexFetchResponse("/api/x", {
				headers: { Cookie: "custom=zzz" },
			});
		});
		expect(headerValue(lastInit, "cookie")).toBe("custom=zzz");
	});

	it("is a no-op when there is no incoming cookie header", async () => {
		await withRequest(null, async () => {
			await vtexFetchResponse("/api/x");
		});
		expect(headerValue(lastInit, "cookie")).toBeUndefined();
	});

	it("is a no-op when there is a cookie header but no vtex_segment", async () => {
		await withRequest("other=foo; another=bar", async () => {
			await vtexFetchResponse("/api/x");
		});
		expect(headerValue(lastInit, "cookie")).toBeUndefined();
	});

	it("does not crash when called outside a RequestContext", async () => {
		await vtexFetchResponse("/api/x");
		expect(headerValue(lastInit, "cookie")).toBeUndefined();
	});

	it("preserves auth headers alongside the forwarded cookie", async () => {
		configureVtex({ account: "testaccount", appKey: "k", appToken: "t" });
		await withRequest("vtex_segment=abc123", async () => {
			await vtexFetchResponse("/api/x");
		});
		expect(headerValue(lastInit, "X-VTEX-API-AppKey")).toBe("k");
		expect(headerValue(lastInit, "X-VTEX-API-AppToken")).toBe("t");
		expect(headerValue(lastInit, "cookie")).toBe("vtex_segment=abc123");
	});

	// Regression: when init.headers is a Headers object (as
	// `createVtexCheckoutProxy` passes through `getVtexFetch()`), the
	// existing cookie must survive verbatim. The naive
	// `{ ...authHeaders, ...init?.headers }` spread collapses a Headers
	// instance to `{}` (Headers has no own enumerable entries), which
	// silently wipes the browser's full Cookie header — including the
	// orderForm cookie any checkout flow depends on.
	it("preserves an existing Cookie header when init.headers is a Headers instance", async () => {
		await withRequest("vtex_segment=abc123", async () => {
			const proxyInit: RequestInit = {
				headers: new Headers({
					cookie: "checkout.vtex.com=__ofid=xyz; vtex_segment=originalseg; foo=bar",
				}),
			};
			await vtexFetchResponse("/api/checkout/pub/orderForm", proxyInit);
		});
		expect(headerValue(lastInit, "cookie")).toContain("checkout.vtex.com=__ofid=xyz");
	});
});

// Module-level counter for cache-busting test URLs. `Date.now()` collides
// when two tests run within the same millisecond and the SWR cache in
// fetchWithCache short-circuits the second one — `_fetch` never runs and
// `lastInit` stays `undefined`. Per-test ids are deterministic and
// collision-free.
let testUrlCounter = 0;
const uniqPath = (prefix: string) => `${prefix}/${++testUrlCounter}`;

describe("vtexCachedFetch — vtex_segment cookie forwarding", () => {
	let lastInit: RequestInit | undefined;

	beforeEach(() => {
		clearFetchCache();
		configureVtex({ account: "testaccount" });
		lastInit = undefined;
		setVtexFetch(((_url: string, init?: RequestInit) => {
			lastInit = init;
			return Promise.resolve(mockResponse({ ok: true }));
		}) as typeof fetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards vtex_segment on cached GETs", async () => {
		await withRequest("vtex_segment=abc123", async () => {
			await vtexCachedFetch(uniqPath("/api/catalog_system/pub/products"));
		});
		expect(headerValue(lastInit, "cookie")).toBe("vtex_segment=abc123");
	});

	it("does not overwrite a caller-supplied cookie header", async () => {
		await withRequest("vtex_segment=abc123", async () => {
			await vtexCachedFetch(uniqPath("/api/x"), {
				headers: { cookie: "custom=zzz" },
			});
		});
		expect(headerValue(lastInit, "cookie")).toBe("custom=zzz");
	});
});

describe("intelligentSearch — vtex_segment cookie forwarding", () => {
	let lastInit: RequestInit | undefined;

	beforeEach(() => {
		// Reset the SWR cache: otherwise the second test in this block
		// can serve the first test's cached body without invoking the
		// stub _fetch, leaving lastInit undefined.
		clearFetchCache();
		configureVtex({ account: "testaccount" });
		lastInit = undefined;
		setVtexFetch(((_url: string, init?: RequestInit) => {
			lastInit = init;
			return Promise.resolve(mockResponse({ products: [] }));
		}) as typeof fetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards vtex_segment when caller didn't pass cookieHeader", async () => {
		await withRequest("vtex_segment=abc123; other=foo", async () => {
			await intelligentSearch(uniqPath("/product_search"));
		});
		expect(headerValue(lastInit, "cookie")).toBe("vtex_segment=abc123");
	});

	it("respects an explicit cookieHeader override", async () => {
		await withRequest("vtex_segment=abc123", async () => {
			await intelligentSearch(uniqPath("/product_search"), undefined, {
				cookieHeader: "custom=zzz",
			});
		});
		expect(headerValue(lastInit, "cookie")).toBe("custom=zzz");
	});
});
