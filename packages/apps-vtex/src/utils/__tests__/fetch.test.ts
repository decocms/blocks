import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAPI, fetchSafe, HttpError } from "../fetch";

const realFetch = globalThis.fetch;

function mockResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		url: "https://example.com",
		json: () => Promise.resolve(body),
	} as Response;
}

describe("fetchSafe", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn() as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("returns the response on 2xx", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse({ ok: true }));
		const res = await fetchSafe("https://example.com/api");
		expect(res.status).toBe(200);
	});

	it("throws HttpError on non-2xx", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse({}, 500));
		await expect(fetchSafe("https://example.com/api")).rejects.toBeInstanceOf(HttpError);
	});

	it("sanitizes utm_* and map params (drops <, > and non-Latin1)", async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue(mockResponse({}));

		await fetchSafe("https://example.com/api?utm_source=<script>café</script>&keep=ok");

		const callArg = fetchMock.mock.calls[0]?.[0] as string;
		expect(callArg).toContain("utm_source=script");
		expect(callArg).not.toContain("<");
		expect(callArg).not.toContain("café");
		expect(callArg).toContain("keep=ok");
	});

	it("forwards init options to fetch", async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue(mockResponse({}));

		await fetchSafe("https://example.com/api", {
			method: "POST",
			headers: { "x-test": "1" },
		});

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["x-test"]).toBe("1");
	});
});

describe("fetchAPI", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn() as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("parses JSON on success", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			mockResponse({ hello: "world" }),
		);
		const data = await fetchAPI<{ hello: string }>("https://example.com/api");
		expect(data).toEqual({ hello: "world" });
	});
});
