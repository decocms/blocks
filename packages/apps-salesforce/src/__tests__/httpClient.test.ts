/**
 * Tests for utils/httpClient.ts.
 *
 * The legacy `apps/utils/http.ts` indexed-route Proxy is what every
 * Deno-era loader called into, so this test file pins the call shapes
 * existing site code still uses:
 *  - `client["POST /api2/event/:dataset"]({ dataset }, { body })`
 *  - `client.get(path)` / `client.post(path, body)` convenience methods
 *  - `:name` placeholder substitution and `*name` legacy Deno-era syntax
 *  - default `x-requested-with` header propagation
 *  - `{ json, ok, status, headers }` response shape
 *
 * `fetch` is mocked so we never touch the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../utils/httpClient";

interface CallRecord {
	url: string;
	init: {
		method?: string;
		body?: string;
		headers: Record<string, string>;
	};
}

type MockedFetch = typeof fetch & {
	mock: { calls: [string, CallRecord["init"]][] };
};

function makeFetch(
	jsonBody: unknown = { ok: true },
	init: { status?: number; headers?: Record<string, string> } = {},
): MockedFetch {
	return vi.fn(async () => ({
		json: async () => jsonBody,
		ok: (init.status ?? 200) < 400,
		status: init.status ?? 200,
		headers: new Headers(init.headers ?? {}),
	})) as unknown as MockedFetch;
}

function callAt(fetcher: MockedFetch, idx: number): CallRecord {
	const call = fetcher.mock.calls[idx];
	return { url: call[0], init: call[1] };
}

describe("createHttpClient", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("strips trailing slash from base URL", async () => {
		const fetcher = makeFetch();
		const client = createHttpClient({ base: "https://api.example.com/", fetcher });
		await client.get("/health");
		expect(callAt(fetcher, 0).url).toBe("https://api.example.com/health");
	});

	it("uses global fetch when no fetcher is provided", async () => {
		globalThis.fetch = makeFetch({ ok: true });
		const client = createHttpClient({ base: "https://api.example.com" });
		const result = await client.get("/health");
		expect(result).toEqual({ ok: true });
		expect(globalThis.fetch).toHaveBeenCalledOnce();
	});

	describe(".get / .post convenience methods", () => {
		it(".get returns parsed JSON directly", async () => {
			const fetcher = makeFetch({ items: [1, 2, 3] });
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			const result = await client.get("/things");
			expect(result).toEqual({ items: [1, 2, 3] });
			expect(callAt(fetcher, 0).url).toBe("https://api.example.com/things");
		});

		it(".post sends JSON body with Content-Type header", async () => {
			const fetcher = makeFetch({ created: true });
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client.post("/things", { name: "thing" });
			const { init } = callAt(fetcher, 0);
			expect(init.method).toBe("POST");
			expect(init.body).toBe(JSON.stringify({ name: "thing" }));
			expect(init.headers["Content-Type"]).toBe("application/json");
		});

		it("merges default headers from options into request", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({
				base: "https://api.example.com",
				fetcher,
				headers: { "x-requested-with": "XMLHttpRequest" },
			});
			await client.post("/things", { name: "x" });
			const { init } = callAt(fetcher, 0);
			expect(init.headers["x-requested-with"]).toBe("XMLHttpRequest");
		});

		it("accepts a Headers object for default headers", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({
				base: "https://api.example.com",
				fetcher,
				headers: new Headers({ "x-token": "abc" }),
			});
			await client.get("/things");
			const { init } = callAt(fetcher, 0);
			expect(init.headers["x-token"]).toBe("abc");
		});
	});

	describe("indexed-route Proxy syntax", () => {
		it("replaces `:name` path placeholders with the matching param", async () => {
			const fetcher = makeFetch({ campaignResponses: [] });
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["POST /api2/event/:dataset"]({ dataset: "production" }, { body: { foo: 1 } });
			expect(callAt(fetcher, 0).url).toBe("https://api.example.com/api2/event/production");
		});

		it("url-encodes placeholder values", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["GET /catalog/:slug"]({ slug: "shoes & boots" });
			expect(callAt(fetcher, 0).url).toBe("https://api.example.com/catalog/shoes%20%26%20boots");
		});

		it("removes leftover `*name` placeholders when no value is provided", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["GET /catalog/*path"]({});
			expect(callAt(fetcher, 0).url).toBe("https://api.example.com/catalog");
		});

		it("substitutes `*name` placeholders when value is present", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["GET /catalog/*path"]({ path: "shoes/boots" });
			expect(callAt(fetcher, 0).url).toBe("https://api.example.com/catalog/shoes/boots");
		});

		it("serialises remaining params as the body on non-GET requests", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["POST /api2/event/:dataset"]({
				dataset: "production",
				extraField: "value",
			});
			const { init } = callAt(fetcher, 0);
			expect(JSON.parse(init.body ?? "")).toEqual({ extraField: "value" });
		});

		it("prefers explicit { body } over remaining params", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["POST /api2/event/:dataset"](
				{ dataset: "production", ignored: "yes" },
				{ body: { real: "body" } },
			);
			const { init } = callAt(fetcher, 0);
			expect(JSON.parse(init.body ?? "")).toEqual({ real: "body" });
		});

		it("encodes remaining params as querystring on GET", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["GET /search"]({ q: "shoes", limit: 12 });
			const call = callAt(fetcher, 0);
			expect(call.url).toBe("https://api.example.com/search?q=shoes&limit=12");
			expect(call.init.body).toBeUndefined();
		});

		it("returns { json, ok, status, headers } from indexed routes", async () => {
			const fetcher = makeFetch({ result: 1 }, { status: 201, headers: { etag: "abc" } });
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			const response = await client["POST /things"]({ name: "x" });
			expect(response.status).toBe(201);
			expect(response.ok).toBe(true);
			expect(response.headers.get("etag")).toBe("abc");
			expect(await response.json()).toEqual({ result: 1 });
		});

		it("appends query when no params remain but route already has `?`", async () => {
			const fetcher = makeFetch();
			const client = createHttpClient({ base: "https://api.example.com", fetcher });
			await client["GET /search?fixed=1"]({ q: "shoes" });
			expect(callAt(fetcher, 0).url).toBe("https://api.example.com/search?fixed=1&q=shoes");
		});

		it("returns undefined for unknown property accesses", () => {
			const client = createHttpClient({ base: "https://api.example.com" });
			// biome-ignore lint/suspicious/noExplicitAny: type-erased access for test
			expect((client as any).somethingMadeUp).toBeUndefined();
		});
	});
});
