/**
 * Tests for the cart loader.
 *
 * Parity goals against deco-cx/apps/magento/loaders/cart.ts (Fresh/Deno,
 * prod):
 *
 *   - Reads `dataservices_cart_id` cookie when caller doesn't supply
 *     `cartId` in props (matches `getCartCookie(req.headers)` in prod).
 *   - Honors props.cartId override (matches `_cartId ?? getCartCookie()`).
 *   - Hits /rest/:site/V1/carts/:cartId — the /rest/ prefix is what the
 *     Magento REST API exposes; the legacy clientAdmin's typed key was
 *     "GET /rest/:site/V1/carts/:cartId".
 *   - Encodes site + cartId so a malicious cookie can't escape the path
 *     segment and reach another admin endpoint with the Bearer token.
 *   - Returns null when no cookie (anonymous visitor — matches prod's
 *     `if (!cartId) return null`).
 *   - Returns null on 404 (expired cookie — prod hits this via the same
 *     branch but throws on other non-2xx; we surface a plain Error).
 *
 * NOT covered by this initial port (and intentionally not tested here):
 *   - Pre-cart `GET /rest/:site/V1/carts/mine` warm-up for logged-in
 *     users (the original does it inside a try/catch and discards the
 *     result — it's a cache primer, not a correctness invariant).
 *   - Parallel /totals fetch + image-pipeline transform — those land in
 *     follow-up PRs that port utils/cart.ts + utils/cache.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureMagento } from "../client";
import cart from "../loaders/cart";

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestWithCookie(cookie: string): Request {
	const r = new Request("http://localhost/");
	// Headers in a freshly-constructed Request enter "request" guard mode
	// which silently drops `cookie`. Build a Headers manually then attach.
	const headers = new Headers();
	headers.set("cookie", cookie);
	Object.defineProperty(r, "headers", { value: headers, configurable: true });
	return r;
}

describe("cart loader", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		configureMagento({
			baseUrl: "https://loja.example.com/",
			apiKey: "secret",
			storeId: 1,
			site: "example",
		});
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when no cart cookie is present", async () => {
		const req = new Request("http://localhost/");
		const result = await cart(undefined, req);
		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reads cartId from the dataservices_cart_id cookie (JSON-encoded)", async () => {
		fetchSpy.mockResolvedValue(mockResponse({ id: "abc123", items: [] }));
		const req = requestWithCookie('dataservices_cart_id="abc123"');
		await cart(undefined, req);
		const [target] = fetchSpy.mock.calls[0] as [URL];
		expect(target.toString()).toBe("https://loja.example.com/rest/example/V1/carts/abc123");
	});

	it("reads cartId from the cookie when it's not JSON-quoted", async () => {
		fetchSpy.mockResolvedValue(mockResponse({ id: "raw-id", items: [] }));
		const req = requestWithCookie("dataservices_cart_id=raw-id");
		await cart(undefined, req);
		const [target] = fetchSpy.mock.calls[0] as [URL];
		expect(target.toString()).toBe("https://loja.example.com/rest/example/V1/carts/raw-id");
	});

	it("honors props.cartId override (cookie ignored)", async () => {
		fetchSpy.mockResolvedValue(mockResponse({ id: "from-props", items: [] }));
		const req = requestWithCookie('dataservices_cart_id="from-cookie"');
		await cart({ cartId: "from-props" }, req);
		const [target] = fetchSpy.mock.calls[0] as [URL];
		expect(target.toString()).toContain("/rest/example/V1/carts/from-props");
	});

	it("URL-encodes the cartId to prevent path injection", async () => {
		// A malicious cookie value tries to break out of the path segment
		// and reach a different admin endpoint with the Bearer attached.
		fetchSpy.mockResolvedValue(mockResponse(null, 404));
		const req = requestWithCookie('dataservices_cart_id="../admin/leak?secret=1"');
		await cart(undefined, req);
		const [target] = fetchSpy.mock.calls[0] as [URL];
		// Encoded: %2F (slash), %3F (?), %3D (=). The trailing
		// "/admin/leak?secret=1" stays inside the path segment.
		expect(target.pathname).toMatch(
			/^\/rest\/example\/V1\/carts\/(\.\.|%2E%2E)%2Fadmin%2Fleak%3Fsecret%3D1$/i,
		);
	});

	it("returns null on 404 (expired cart cookie)", async () => {
		fetchSpy.mockResolvedValue(mockResponse(null, 404));
		const req = requestWithCookie('dataservices_cart_id="stale"');
		const result = await cart(undefined, req);
		expect(result).toBeNull();
	});

	it("throws on non-404 errors", async () => {
		fetchSpy.mockResolvedValue(mockResponse(null, 500));
		const req = requestWithCookie('dataservices_cart_id="abc"');
		await expect(cart(undefined, req)).rejects.toThrow(/cart loader: 500/);
	});

	it("attaches Bearer + x-origin-header (same-origin) on the cart fetch", async () => {
		configureMagento({
			baseUrl: "https://loja.example.com/",
			apiKey: "secret",
			storeId: 1,
			site: "example",
			originHeader: "origin-secret",
		});
		fetchSpy.mockResolvedValue(mockResponse({ id: "abc", items: [] }));
		const req = requestWithCookie('dataservices_cart_id="abc"');
		await cart(undefined, req);
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("authorization")).toBe("Bearer secret");
		expect(headers.get("x-origin-header")).toBe("origin-secret");
	});
});
