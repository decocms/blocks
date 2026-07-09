/**
 * Tests for the wishlist add/remove actions.
 *
 * Parity goals against deco-cx/apps/magento/actions/wishlist/{addItem,removeItem}:
 *   - Both require PHPSESSID + form_key cookies; return null when either absent.
 *   - addItem POSTs FormData {product, form_key} to /wishlist/index/add/.
 *   - removeItem POSTs FormData {item, uenc:"", form_key} to /wishlist/index/remove/.
 *   - On success ({success:true}) both delegate to the wishlist loader to
 *     fetch the refreshed list.
 *   - Failure / thrown / success:false → null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addItem from "../actions/wishlist/addItem";
import removeItem from "../actions/wishlist/removeItem";
import { configureMagento } from "../client";

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestWithCookies(cookieHeader: string): Request {
	const r = new Request("http://localhost/");
	const headers = new Headers();
	headers.set("cookie", cookieHeader);
	Object.defineProperty(r, "headers", { value: headers, configurable: true });
	return r;
}

const AUTHED = "PHPSESSID=abc; form_key=xyz";

describe("wishlist/addItem", () => {
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

	afterEach(() => vi.restoreAllMocks());

	it("returns null when PHPSESSID is missing", async () => {
		expect(await addItem({ productId: "1" }, requestWithCookies("form_key=xyz"))).toBeNull();
	});

	it("returns null when form_key is missing", async () => {
		expect(await addItem({ productId: "1" }, requestWithCookies("PHPSESSID=abc"))).toBeNull();
	});

	it("POSTs FormData {product, form_key} to /wishlist/index/add/", async () => {
		fetchSpy
			.mockResolvedValueOnce(mockResponse({ success: true })) // POST add
			.mockResolvedValueOnce(
				mockResponse({
					wishlist: { counter: "1", items: [], counter_number: 1, data_id: 1 },
				}),
			); // wishlist loader fetch

		await addItem({ productId: "p42" }, requestWithCookies(AUTHED));

		const [target, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(target.toString()).toBe("https://loja.example.com/example/wishlist/index/add/");
		expect(init.method).toBe("POST");

		const fd = init.body as FormData;
		expect(fd.get("product")).toBe("p42");
		expect(fd.get("form_key")).toBe("xyz");
	});

	it("delegates to the wishlist loader on success", async () => {
		const wl = { counter: "1", items: [], counter_number: 1, data_id: 1 };
		fetchSpy
			.mockResolvedValueOnce(mockResponse({ success: true }))
			.mockResolvedValueOnce(mockResponse({ wishlist: wl }));

		expect(await addItem({ productId: "p42" }, requestWithCookies(AUTHED))).toEqual(wl);
	});

	it("returns null when Magento responds with success:false", async () => {
		fetchSpy.mockResolvedValueOnce(mockResponse({ success: false }));
		expect(await addItem({ productId: "p42" }, requestWithCookies(AUTHED))).toBeNull();
	});

	it("returns null on a thrown fetch", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("boom"));
		expect(await addItem({ productId: "p42" }, requestWithCookies(AUTHED))).toBeNull();
	});
});

describe("wishlist/removeItem", () => {
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

	afterEach(() => vi.restoreAllMocks());

	it("POSTs FormData {item, uenc:'', form_key} to /wishlist/index/remove/", async () => {
		fetchSpy.mockResolvedValueOnce(mockResponse({ success: true })).mockResolvedValueOnce(
			mockResponse({
				wishlist: { counter: "0", items: [], counter_number: 0, data_id: 1 },
			}),
		);

		await removeItem({ productId: "row-42" }, requestWithCookies(AUTHED));

		const [target, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(target.toString()).toBe("https://loja.example.com/example/wishlist/index/remove/");
		const fd = init.body as FormData;
		expect(fd.get("item")).toBe("row-42");
		expect(fd.get("uenc")).toBe("");
		expect(fd.get("form_key")).toBe("xyz");
	});

	it("returns the refreshed wishlist on success", async () => {
		const wl = { counter: "0", items: [], counter_number: 0, data_id: 1 };
		fetchSpy
			.mockResolvedValueOnce(mockResponse({ success: true }))
			.mockResolvedValueOnce(mockResponse({ wishlist: wl }));
		expect(await removeItem({ productId: "row-42" }, requestWithCookies(AUTHED))).toEqual(wl);
	});

	it("returns null when PHPSESSID is missing", async () => {
		expect(await removeItem({ productId: "x" }, requestWithCookies("form_key=xyz"))).toBeNull();
	});
});
