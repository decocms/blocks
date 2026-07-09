/**
 * Regression tests for the Set-Cookie propagation chain through
 * `vtexFetchWithCookies`. Without this chain, VTEX's `checkout.vtex.com`
 * and `CheckoutOrderFormOwnership` cookies never reach the browser via
 * `createServerFn` actions, the storefront's local `__orderFormId`
 * drifts away from VTEX's server-side orderForm, and the user lands
 * on `/checkout` with an empty cart.
 *
 * Two failure modes covered here:
 *
 *  (1) Inbound capture — VTEX `Set-Cookie` headers must be appended
 *      to `RequestContext.responseHeaders`, skipping the two IS
 *      cookies that the middleware owns (`vtex_is_session`,
 *      `vtex_is_anonymous`), and the `domain=` attribute must be
 *      stripped so the browser scopes the cookie to the storefront.
 *
 *  (2) Outbound merge — when the caller passes `init.headers` as a
 *      `Headers` instance (the `createVtexCheckoutProxy` factory does
 *      this through `getVtexFetch()`), spreading it as a plain object
 *      collapses to `{}` and silently wipes every other header the
 *      caller set. The Headers-aware merge in `vtexFetchWithCookies`
 *      keeps the bug from sneaking back in.
 */

import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureVtex, setVtexFetch, vtexFetchWithCookies } from "../client";

function mockResponse(opts?: { body?: unknown; status?: number; setCookies?: string[] }): Response {
	const status = opts?.status ?? 200;
	const headers = new Headers();
	for (const c of opts?.setCookies ?? []) headers.append("set-cookie", c);
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		headers,
		json: () => Promise.resolve(opts?.body ?? {}),
	} as Response;
}

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

function withRequest<T>(
	cookieHeader: string | null,
	fn: (ctx: { responseHeaders: Headers }) => Promise<T>,
	requestUrl = "https://store.example.com/api/checkout/pub/orderForm",
): Promise<T> {
	const reqHeaders = new Headers();
	if (cookieHeader) reqHeaders.set("cookie", cookieHeader);
	const responseHeaders = new Headers();
	const fakeCtx = {
		request: { headers: reqHeaders, url: requestUrl } as unknown as Request,
		signal: new AbortController().signal,
		responseHeaders,
		bag: new Map(),
		startedAt: Date.now(),
	};
	const spy = vi
		.spyOn(RequestContext, "current", "get")
		.mockReturnValue(fakeCtx as unknown as ReturnType<typeof Reflect.get>);
	return fn({ responseHeaders }).finally(() => spy.mockRestore());
}

describe("vtexFetchWithCookies — inbound Set-Cookie capture", () => {
	let lastInit: RequestInit | undefined;

	beforeEach(() => {
		configureVtex({ account: "testaccount" });
		lastInit = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("captures upstream Set-Cookie into RequestContext.responseHeaders", async () => {
		setVtexFetch(((_url: string, init?: RequestInit) => {
			lastInit = init;
			return Promise.resolve(
				mockResponse({
					setCookies: [
						"checkout.vtex.com=__ofid=abc123; Path=/; HttpOnly; Secure",
						"CheckoutOrderFormOwnership=def456; Path=/; HttpOnly",
					],
				}),
			);
		}) as typeof fetch);

		const captured = await withRequest("vtex_segment=seg1", async ({ responseHeaders }) => {
			await vtexFetchWithCookies("/api/checkout/pub/orderForm");
			return responseHeaders.getSetCookie();
		});

		expect(captured).toHaveLength(2);
		expect(captured.some((c) => c.startsWith("checkout.vtex.com="))).toBe(true);
		expect(captured.some((c) => c.startsWith("CheckoutOrderFormOwnership="))).toBe(true);
	});

	// The cart server-fn cookie MUST land at the same scope as the checkout
	// proxy (domain-scoped to the storefront host) and native VTEX
	// (`domain=<host>`). Stripping the Domain (host-only) creates a second,
	// distinct cookie that drifts from the proxy's and causes the
	// nondeterministic empty-cart bug. So we rewrite Domain, not strip it.
	it("rewrites the Domain= attribute to the storefront host (matches the proxy)", async () => {
		setVtexFetch((() =>
			Promise.resolve(
				mockResponse({
					setCookies: [
						"checkout.vtex.com=__ofid=abc; Domain=.vtexcommercestable.com.br; Path=/; HttpOnly",
					],
				}),
			)) as typeof fetch);

		const captured = await withRequest(
			"foo=bar",
			async ({ responseHeaders }) => {
				await vtexFetchWithCookies("/api/checkout/pub/orderForm");
				return responseHeaders.getSetCookie();
			},
			"https://www.casaevideo.com.br/api/checkout/pub/orderForm",
		);

		// domain-scoped to the storefront host, NOT the original VTEX domain
		expect(captured[0]).toMatch(/Domain=www\.casaevideo\.com\.br/);
		expect(captured[0]).not.toMatch(/vtexcommercestable/i);
		expect(captured[0]).toContain("checkout.vtex.com=__ofid=abc");
	});

	it("rewrites only the Domain attribute, not a domain= substring in the cookie value", async () => {
		setVtexFetch((() =>
			Promise.resolve(
				mockResponse({
					// Pathological value embedding `domain=` before the first `;`.
					setCookies: [
						"checkout.vtex.com=__ofid=domain=keep; Domain=.vtexcommercestable.com.br; Path=/",
					],
				}),
			)) as typeof fetch);

		const captured = await withRequest(
			"foo=bar",
			async ({ responseHeaders }) => {
				await vtexFetchWithCookies("/api/checkout/pub/orderForm");
				return responseHeaders.getSetCookie();
			},
			"https://www.casaevideo.com.br/api/checkout/pub/orderForm",
		);

		// the value's `domain=keep` is untouched; the attribute is rewritten
		expect(captured[0]).toContain("__ofid=domain=keep");
		expect(captured[0]).toMatch(/;\s*Domain=www\.casaevideo\.com\.br/);
		expect(captured[0]).not.toMatch(/vtexcommercestable/i);
	});

	it("falls back to stripping Domain when there is no request scope (module init)", async () => {
		setVtexFetch((() =>
			Promise.resolve(
				mockResponse({
					setCookies: ["checkout.vtex.com=__ofid=abc; Domain=.vtexcommercestable.com.br; Path=/"],
				}),
			)) as typeof fetch);
		// No withRequest wrapper → RequestContext.current is null.
		await expect(vtexFetchWithCookies("/api/checkout/pub/orderForm")).resolves.toBeDefined();
	});

	it("skips Intelligent Search cookies (managed by middleware, not actions)", async () => {
		setVtexFetch((() =>
			Promise.resolve(
				mockResponse({
					setCookies: [
						"checkout.vtex.com=__ofid=abc; Path=/",
						"vtex_is_session=ignore-me; Path=/",
						"vtex_is_anonymous=ignore-me-too; Path=/",
						"CheckoutOrderFormOwnership=def; Path=/",
					],
				}),
			)) as typeof fetch);

		const captured = await withRequest("foo=bar", async ({ responseHeaders }) => {
			await vtexFetchWithCookies("/api/checkout/pub/orderForm");
			return responseHeaders.getSetCookie();
		});

		expect(captured.some((c) => c.startsWith("checkout.vtex.com="))).toBe(true);
		expect(captured.some((c) => c.startsWith("CheckoutOrderFormOwnership="))).toBe(true);
		expect(captured.some((c) => c.startsWith("vtex_is_session="))).toBe(false);
		expect(captured.some((c) => c.startsWith("vtex_is_anonymous="))).toBe(false);
	});

	it("does not crash when called outside a RequestContext", async () => {
		setVtexFetch((() =>
			Promise.resolve(
				mockResponse({
					setCookies: ["checkout.vtex.com=__ofid=abc; Path=/"],
				}),
			)) as typeof fetch);
		await expect(vtexFetchWithCookies("/api/checkout/pub/orderForm")).resolves.toBeDefined();
	});

	// Regression for Hole B: when init.headers is a Headers instance,
	// the previous Record-cast + spread collapsed it to `{}`, wiping
	// every other header (auth, content-type) the caller set. After
	// the fix, the Headers-aware merge preserves all of them.
	it("preserves other caller headers when init.headers is a Headers instance", async () => {
		setVtexFetch(((_url: string, init?: RequestInit) => {
			lastInit = init;
			return Promise.resolve(mockResponse());
		}) as typeof fetch);

		await withRequest("vtex_segment=abc; foo=bar", async () => {
			await vtexFetchWithCookies("/api/checkout/pub/orderForm", {
				headers: new Headers({
					"X-Custom-Trace": "trace-id",
					"X-VTEX-Operation": "test-op",
				}),
			});
		});

		expect(headerValue(lastInit, "x-custom-trace")).toBe("trace-id");
		expect(headerValue(lastInit, "x-vtex-operation")).toBe("test-op");
		// Caller didn't pass a Cookie — auto-injection picks up the
		// request's cookie and forwards it without dropping the
		// other headers.
		expect(headerValue(lastInit, "cookie")).toBeDefined();
	});

	it("preserves an existing Cookie header passed via Headers and sanitises it in place", async () => {
		setVtexFetch(((_url: string, init?: RequestInit) => {
			lastInit = init;
			return Promise.resolve(mockResponse());
		}) as typeof fetch);

		await withRequest("vtex_segment=abc", async () => {
			await vtexFetchWithCookies("/api/checkout/pub/orderForm", {
				headers: new Headers({
					"X-Custom": "keep-me",
					cookie: "checkout.vtex.com=__ofid=xyz; vtex_segment=mine",
				}),
			});
		});

		expect(headerValue(lastInit, "x-custom")).toBe("keep-me");
		expect(headerValue(lastInit, "cookie")).toContain("checkout.vtex.com=__ofid=xyz");
	});
});
