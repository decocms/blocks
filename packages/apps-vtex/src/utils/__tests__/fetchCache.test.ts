import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFetchCache, fetchWithCache, getFetchCacheStats } from "../fetchCache";

function mockResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		json: () => Promise.resolve(body),
	} as Response;
}

describe("fetchWithCache", () => {
	beforeEach(() => {
		clearFetchCache();
	});

	it("returns fetched data on cache miss", async () => {
		const data = { id: 1, name: "product" };
		const doFetch = vi.fn(() => Promise.resolve(mockResponse(data)));

		const result = await fetchWithCache("key1", doFetch);
		expect(result).toEqual(data);
		expect(doFetch).toHaveBeenCalledOnce();
	});

	it("returns cached data on subsequent calls", async () => {
		const data = { id: 1 };
		const doFetch = vi.fn(() => Promise.resolve(mockResponse(data)));

		await fetchWithCache("key2", doFetch);
		const result = await fetchWithCache("key2", doFetch);

		expect(result).toEqual(data);
		expect(doFetch).toHaveBeenCalledOnce();
	});

	it("deduplicates in-flight requests", async () => {
		const data = { id: 1 };
		const doFetch = vi.fn(
			() => new Promise<Response>((resolve) => setTimeout(() => resolve(mockResponse(data)), 10)),
		);

		const [r1, r2] = await Promise.all([
			fetchWithCache("key3", doFetch),
			fetchWithCache("key3", doFetch),
		]);

		expect(r1).toEqual(data);
		expect(r2).toEqual(data);
		expect(doFetch).toHaveBeenCalledOnce();
	});

	it("throws on 5xx responses", async () => {
		const doFetch = vi.fn(() => Promise.resolve(mockResponse(null, 500)));

		await expect(fetchWithCache("key4", doFetch)).rejects.toThrow("500");
	});

	it("returns null for 404 responses", async () => {
		const doFetch = vi.fn(() => Promise.resolve(mockResponse(null, 404)));

		const result = await fetchWithCache("key5", doFetch);
		expect(result).toBeNull();
	});

	it("tracks cache stats", async () => {
		const doFetch = () => Promise.resolve(mockResponse({ ok: true }));

		expect(getFetchCacheStats()).toEqual({ entries: 0, inflight: 0 });

		await fetchWithCache("stats1", doFetch);
		await fetchWithCache("stats2", doFetch);

		expect(getFetchCacheStats()).toEqual({ entries: 2, inflight: 0 });
	});

	it("clears cache", async () => {
		const doFetch = () => Promise.resolve(mockResponse({ ok: true }));
		await fetchWithCache("clear1", doFetch);

		clearFetchCache();
		expect(getFetchCacheStats()).toEqual({ entries: 0, inflight: 0 });
	});

	it("evicts the inflight slot when the fetch never settles", async () => {
		vi.useFakeTimers();
		try {
			// `doFetch` returns a Promise that never resolves — simulates a hung
			// VTEX subrequest (TCP open, no FIN, no response). Without the
			// timeout guard, the inflight Map entry would leak forever and
			// subsequent callers would `await` a zombie Promise — the prod
			// memory-leak this fix addresses.
			const doFetch = vi.fn(() => new Promise<Response>(() => {}));

			const pending = fetchWithCache("hung-key", doFetch);
			// Swallow the eventual rejection so the unhandled rejection doesn't
			// fail the test runner.
			pending.catch(() => {});

			expect(getFetchCacheStats().inflight).toBe(1);

			// Fast-forward past the 10s fetch timeout.
			await vi.advanceTimersByTimeAsync(11_000);

			await expect(pending).rejects.toThrow(/timed out/);
			expect(getFetchCacheStats().inflight).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
