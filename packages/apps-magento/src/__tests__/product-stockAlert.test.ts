/**
 * Tests for the product/stockAlert action.
 *
 * Parity with deco-cx/apps/magento/actions/product/stockAlert.ts:
 *   - Calls Magento's GraphQL endpoint at <baseUrl>/graphql.
 *   - Sends operationName ProductStockAlert + variables {product_id, name, email}.
 *   - Returns { data: { productStockAlert } } on success.
 *   - Returns { error } on thrown exceptions / missing payload.
 *
 * The legacy code passed a STALE cache hint to clientGraphql.query but
 * mutations are never cached server-side, so the TanStack port omits it
 * — behavior is observationally identical from a consumer perspective.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stockAlert from "../actions/product/stockAlert";
import { configureMagento } from "../client";

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("product/stockAlert", () => {
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

	it("POSTs to <baseUrl>/graphql with the ProductStockAlert mutation", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				data: { productStockAlert: { message: "ok", status: true } },
			}),
		);
		await stockAlert({ product_id: 42, name: "Alice", email: "a@b.com" });
		const [target, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(target.toString()).toBe("https://loja.example.com/graphql");
		expect(init.method).toBe("POST");

		const body = JSON.parse(init.body as string);
		expect(body.operationName).toBe("ProductStockAlert");
		expect(body.variables).toEqual({ product_id: 42, name: "Alice", email: "a@b.com" });
		expect(body.query).toMatch(/mutation ProductStockAlert/);
	});

	it("returns { data: { productStockAlert } } on success", async () => {
		fetchSpy.mockResolvedValue(
			mockResponse({
				data: { productStockAlert: { message: "added", status: true } },
			}),
		);
		const out = await stockAlert({ product_id: 1, name: "n", email: "e@e.com" });
		expect(out).toEqual({ data: { productStockAlert: { message: "added", status: true } } });
	});

	it("returns { error } when the GraphQL response lacks productStockAlert", async () => {
		fetchSpy.mockResolvedValue(mockResponse({ data: {} }));
		const out = await stockAlert({ product_id: 1, name: "n", email: "e@e.com" });
		expect(out).toHaveProperty("error");
	});

	it("returns { error } when fetch throws (network error)", async () => {
		fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
		const out = await stockAlert({ product_id: 1, name: "n", email: "e@e.com" });
		expect(out).toEqual({ error: "ECONNREFUSED" });
	});
});
