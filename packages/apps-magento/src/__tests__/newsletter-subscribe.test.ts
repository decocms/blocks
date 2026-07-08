/**
 * Tests for the newsletter/subscribe action.
 *
 * Parity with deco-cx/apps/magento/actions/newsletter/subscribe.ts:
 *   - POSTs to /rest/:site/V1/newsletter/subscribed
 *   - Body shape: { email, store_id: number }
 *   - storeId is coerced to number even if the CMS block holds it as string
 *   - Returns null on non-2xx or when `success === false`, the payload otherwise
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subscribe from "../actions/newsletter/subscribe";
import { configureMagento } from "../client";

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("newsletter/subscribe", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		configureMagento({
			baseUrl: "https://loja.example.com/",
			apiKey: "secret",
			storeId: 21,
			site: "example",
		});
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs to the correct REST path with the encoded site", async () => {
		fetchSpy.mockResolvedValue(mockResponse({ success: true, message: "ok" }));
		await subscribe({ email: "a@b.com" });
		const [target, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(target.toString()).toBe(
			"https://loja.example.com/rest/example/V1/newsletter/subscribed",
		);
		expect(init.method).toBe("POST");
	});

	it("sends { email, store_id (number) } as JSON body", async () => {
		fetchSpy.mockResolvedValue(mockResponse({ success: true, message: "ok" }));
		await subscribe({ email: "a@b.com" });
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.com", store_id: 21 });
	});

	it("coerces storeId to number even if config holds a string-shaped value", async () => {
		// Some CMS blocks store storeId as a string. The prod loader did
		// `Number(storeId)` defensively; we keep that behavior so the
		// Magento backend never receives a string for an int field.
		configureMagento({
			baseUrl: "https://loja.example.com/",
			apiKey: "secret",
			storeId: "42" as unknown as number,
			site: "example",
		});
		fetchSpy.mockResolvedValue(mockResponse({ success: true, message: "ok" }));
		await subscribe({ email: "a@b.com" });
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(JSON.parse(init.body as string).store_id).toBe(42);
	});

	it("returns the payload on success", async () => {
		const payload = { success: true, message: "ok" };
		fetchSpy.mockResolvedValue(mockResponse(payload));
		expect(await subscribe({ email: "a@b.com" })).toEqual(payload);
	});

	it("returns null on success:false (Magento failure shape)", async () => {
		fetchSpy.mockResolvedValue(mockResponse({ success: false, message: "no" }));
		expect(await subscribe({ email: "a@b.com" })).toBeNull();
	});

	it("returns null on non-2xx HTTP status", async () => {
		fetchSpy.mockResolvedValue(mockResponse(null, 500));
		expect(await subscribe({ email: "a@b.com" })).toBeNull();
	});
});
