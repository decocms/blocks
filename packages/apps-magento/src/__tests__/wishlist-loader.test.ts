/**
 * Tests for the wishlist loader.
 *
 * Parity goals against deco-cx/apps/magento/loaders/wishlist.ts:
 *   - Returns null when no PHPSESSID (anonymous).
 *   - Hits /customer/section/load?sections=wishlist with the Cookie header.
 *   - Returns the wishlist payload directly when present.
 *   - Returns null when the bundle has no wishlist slice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureMagento } from "../client";
import wishlist from "../loaders/wishlist";

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestWithCookie(cookie: string): Request {
	const r = new Request("http://localhost/");
	const headers = new Headers();
	headers.set("cookie", cookie);
	Object.defineProperty(r, "headers", { value: headers, configurable: true });
	return r;
}

describe("wishlist loader", () => {
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

	it("returns null when no PHPSESSID cookie is present", async () => {
		expect(await wishlist(null, new Request("http://localhost/"))).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("requests /customer/section/load?sections=wishlist", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				wishlist: { counter: "0", items: [], counter_number: 0, data_id: 1 },
			}),
		);
		await wishlist(null, requestWithCookie("PHPSESSID=abc"));
		const [target] = fetchSpy.mock.calls[0] as [URL];
		expect(target.toString()).toBe(
			"https://loja.example.com/example/customer/section/load?sections=wishlist",
		);
	});

	it("returns the wishlist payload on success", async () => {
		const wl = {
			counter: "1",
			counter_number: 1,
			data_id: 1,
			items: [
				{
					image: { template: "", src: "", width: 0, height: 0, alt: "" },
					product_sku: "ABC",
					product_id: "1",
					product_url: "",
					product_name: "n",
					product_price: "10",
					product_is_saleable_and_visible: true,
					product_has_required_options: false,
					add_to_cart_params: "",
					delete_item_params: "",
				},
			],
		};
		fetchSpy.mockResolvedValue(mockResponse({ wishlist: wl }));
		expect(await wishlist(null, requestWithCookie("PHPSESSID=abc"))).toEqual(wl);
	});

	it("returns null when bundle lacks a wishlist slice", async () => {
		fetchSpy.mockResolvedValue(mockResponse({}));
		expect(await wishlist(null, requestWithCookie("PHPSESSID=abc"))).toBeNull();
	});

	it("returns null on non-2xx response", async () => {
		fetchSpy.mockResolvedValue(mockResponse(null, 500));
		expect(await wishlist(null, requestWithCookie("PHPSESSID=abc"))).toBeNull();
	});
});
