/**
 * App credentials (appKey/appToken) must only reach the VTEX endpoints that
 * need them, and no request path may be rewritten by URL normalization.
 *
 * Regression for the orderFormId path traversal: `getOrCreateCart` with
 * `orderFormId: "../../../dataentities/CL/search?_fields=email&_size=0#"`
 * resolved to `/api/dataentities/CL/search` and, because credentials were
 * stamped on every call, read the customer table as the store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateCart } from "../actions/checkout";
import {
	assertNoDotSegments,
	configureVtex,
	intelligentSearch,
	needsAppCredentials,
	setVtexFetch,
	vtexCachedFetch,
	vtexFetch,
	vtexFetchResponse,
} from "../client";
import { clearFetchCache } from "../utils/fetchCache";

const ACCOUNT = "store";
const STABLE = `https://${ACCOUNT}.vtexcommercestable.com.br`;
const TRAVERSAL = "../../../dataentities/CL/search?_fields=email&_size=0#";

function mockResponse(body: unknown = {}): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers(),
		json: () => Promise.resolve(body),
		clone() {
			return mockResponse(body);
		},
	} as unknown as Response;
}

function appKeyOf(init: RequestInit | undefined): string | null {
	return new Headers(init?.headers).get("X-VTEX-API-AppKey");
}

const fetchMock = vi.fn();

beforeEach(() => {
	configureVtex({ account: ACCOUNT, appKey: "key", appToken: "token" });
	fetchMock.mockReset();
	fetchMock.mockImplementation(() => Promise.resolve(mockResponse({})));
	setVtexFetch(fetchMock as unknown as typeof fetch);
	clearFetchCache();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("needsAppCredentials", () => {
	it.each([
		[`${STABLE}/api/catalog_system/pvt/saleschannel/list`, true],
		[`${STABLE}/api/logistics/pvt/configuration/pickuppoints`, true],
		[`${STABLE}/api/rnb/pvt/calculatorconfiguration/1`, true],
		[`${STABLE}/api/dataentities/NL/documents`, true],
		[`https://${ACCOUNT}.vtexcommercebeta.com.br/api/catalog_system/pvt/x`, true],
		[`https://${ACCOUNT}.myvtex.com/_v/private/graphql/v1`, true],
		[`https://${ACCOUNT}.myvtex.com/reviews-and-ratings/api/reviews`, true],
		[`${STABLE}/api/checkout/pub/orderForm/abc`, false],
		[`${STABLE}/api/catalog_system/pub/products/search/`, false],
		[`${STABLE}/api/io/_v/api/intelligent-search/product_search/`, false],
		[`${STABLE}/api/sessions`, false],
		[`${STABLE}/api/vtexid/pub/authentication/start`, false],
		[`${STABLE}/api/oms/user/orders`, false],
		[`${STABLE}/api/checkout/changeToAnonymousUser/abc`, false],
		// A pvt-looking path on someone else's host never gets the store's keys.
		["https://evil.example.com/api/catalog_system/pvt/x", false],
		[`https://other.vtexcommercestable.com.br/api/dataentities/CL/search`, false],
		[`http://${ACCOUNT}.vtexcommercestable.com.br/api/dataentities/CL/search`, false],
		// `pvt` must be a whole segment.
		[`${STABLE}/api/catalog_system/pub/pvtx`, false],
	])("%s → %s", (url, expected) => {
		expect(needsAppCredentials(url)).toBe(expected);
	});
});

describe("assertNoDotSegments", () => {
	it.each([
		`${STABLE}/api/checkout/pub/orderForm/../../../dataentities/CL/search`,
		`${STABLE}/api/checkout/pub/orderForm/./x`,
		`${STABLE}/api/checkout/pub/orderForm/%2e%2e/x`,
		`${STABLE}/api/checkout/pub/orderForm/.%2E/x`,
		`${STABLE}/api/checkout/pub/orderForm/%2E./x`,
		`${STABLE}/api/checkout/pub/orderForm/..\\..\\x`,
		`${STABLE}/api/checkout/pub/orderForm/.\t./x`,
		`/api/checkout/pub/orderForm/..`,
	])("rejects %s", (raw) => {
		expect(() => assertNoDotSegments(raw)).toThrow(/vtex: refusing/);
	});

	it.each([
		`${STABLE}/api/checkout/pub/orderForm/31608bfb4aba45a8beafe03d60f7447a?sc=1`,
		`${STABLE}/api/catalog_system/pub/products/search/anel...ouro/p`,
		`${STABLE}/api/catalog_system/pub/products/search/?fq=a/../b`,
		`${STABLE}/api/checkout/pub/orderForm/x#../../y`,
	])("accepts %s", (raw) => {
		expect(() => assertNoDotSegments(raw)).not.toThrow();
	});
});

describe("client entry points", () => {
	it("vtexFetchResponse sends credentials to pvt and not to pub", async () => {
		await vtexFetchResponse("/api/catalog_system/pvt/saleschannel/list");
		await vtexFetchResponse("/api/checkout/pub/orderForm/abc");
		expect(appKeyOf(fetchMock.mock.calls[0][1])).toBe("key");
		expect(appKeyOf(fetchMock.mock.calls[1][1])).toBeNull();
	});

	it("vtexCachedFetch scopes credentials the same way", async () => {
		await vtexCachedFetch("/api/catalog_system/pub/products/search/x/p");
		await vtexCachedFetch("/api/logistics/pvt/inventory/skus/1");
		expect(appKeyOf(fetchMock.mock.calls[0][1])).toBeNull();
		expect(appKeyOf(fetchMock.mock.calls[1][1])).toBe("key");
	});

	it("intelligentSearch never sends credentials", async () => {
		await intelligentSearch("/product_search/", { query: "anel" });
		expect(appKeyOf(fetchMock.mock.calls[0][1])).toBeNull();
	});

	it("intelligentSearch refuses a traversal path", async () => {
		await expect(intelligentSearch("/../../../dataentities/CL/search")).rejects.toThrow(
			/vtex: refusing/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("an explicit caller AppKey header still wins (opt-in)", async () => {
		await vtexFetch("/api/checkout/pub/orderForm/abc", {
			headers: { "X-VTEX-API-AppKey": "explicit" },
		});
		expect(appKeyOf(fetchMock.mock.calls[0][1])).toBe("explicit");
	});
});

describe("orderFormId traversal (the reported exploit)", () => {
	it("is refused before any request is made", async () => {
		await expect(getOrCreateCart({ orderFormId: TRAVERSAL })).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
