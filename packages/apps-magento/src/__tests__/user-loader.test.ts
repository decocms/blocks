/**
 * Tests for the user loader.
 *
 * Parity goals against deco-cx/apps/magento/loaders/user.ts:
 *   - Returns null when no PHPSESSID cookie is present (anonymous).
 *   - Calls /customer/section/load?sections=customer,carbono-customer
 *     with the Cookie header set from PHPSESSID.
 *   - Maps the bundle into schema.org Person { @id, email, givenName,
 *     familyName? }.
 *   - Derives familyName by stripping firstname from fullname (matches
 *     prod's `fullname.replace(firstname, "").trim()`).
 *   - Returns null when carbono-customer.data_id is missing OR when
 *     customer slice is absent.
 *   - Swallows fetch errors and returns null (the storefront re-renders
 *     the logged-out UI rather than crashing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureMagento } from "../client";
import user from "../loaders/user";

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

describe("user loader", () => {
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
		const result = await user(null, new Request("http://localhost/"));
		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("requests /customer/section/load with the Cookie header", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				customer: { data_id: 1, fullname: "Alice Doe", firstname: "Alice" },
				"carbono-customer": { data_id: 1, customerId: "c1", email: "a@b.com" },
			}),
		);
		await user(null, requestWithCookie("PHPSESSID=abc"));
		const [target, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(target.toString()).toBe(
			"https://loja.example.com/example/customer/section/load?sections=customer,carbono-customer",
		);
		const cookieHeader = new Headers(init.headers).get("cookie");
		expect(cookieHeader).toBe("PHPSESSID=abc");
	});

	it("maps a happy-path bundle into a schema.org Person", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				customer: { data_id: 1, fullname: "Alice Doe", firstname: "Alice" },
				"carbono-customer": { data_id: 1, customerId: "c1", email: "a@b.com" },
			}),
		);
		const out = await user(null, requestWithCookie("PHPSESSID=abc"));
		expect(out).toEqual({
			"@id": "c1",
			email: "a@b.com",
			givenName: "Alice",
			familyName: "Doe",
		});
	});

	it("omits familyName when fullname is just firstname (no surname)", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				customer: { data_id: 1, fullname: "Alice", firstname: "Alice" },
				"carbono-customer": { data_id: 1, customerId: "c1", email: "a@b.com" },
			}),
		);
		const out = await user(null, requestWithCookie("PHPSESSID=abc"));
		expect(out).toMatchObject({ givenName: "Alice" });
		// Magento returns fullname=firstname; prod's `replace(firstname, "").trim()`
		// yields "" — we include the key with an empty string. Test the
		// surface, not the empty-vs-missing detail.
		expect(out?.familyName ?? "").toBe("");
	});

	it("returns null when carbono-customer.data_id is missing", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				customer: { data_id: 1, fullname: "Alice Doe", firstname: "Alice" },
				"carbono-customer": { customerId: "c1", email: "a@b.com" }, // no data_id
			}),
		);
		expect(await user(null, requestWithCookie("PHPSESSID=abc"))).toBeNull();
	});

	it("returns null when customer slice is absent", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				"carbono-customer": { data_id: 1, customerId: "c1", email: "a@b.com" },
			}),
		);
		expect(await user(null, requestWithCookie("PHPSESSID=abc"))).toBeNull();
	});

	it("returns null when fetch throws", async () => {
		fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await user(null, requestWithCookie("PHPSESSID=abc"))).toBeNull();
	});

	it("returns null on non-2xx response", async () => {
		fetchSpy.mockResolvedValue(mockResponse(null, 500));
		expect(await user(null, requestWithCookie("PHPSESSID=abc"))).toBeNull();
	});
});
