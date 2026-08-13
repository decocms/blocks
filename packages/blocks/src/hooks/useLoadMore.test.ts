import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useLoadMore, getNextPageUrl } from "./useLoadMore";

// ---------------------------------------------------------------------------
// Minimal hook runner for jsdom (no @testing-library/react dependency)
// ---------------------------------------------------------------------------

function makeHookRunner<T>(useHookFn: () => T) {
	let value!: T;
	let root!: Root;
	const container = document.createElement("div");
	document.body.appendChild(container);

	const Wrapper = () => {
		value = useHookFn();
		return null;
	};

	return {
		async mount() {
			await act(async () => {
				root = createRoot(container);
				root.render(createElement(Wrapper));
			});
			return value;
		},
		get current(): T {
			return value;
		},
		async rerender() {
			await act(async () => {
				root.render(createElement(Wrapper));
			});
			return value;
		},
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const PAGE1 = { products: ["a"], pageInfo: { nextPage: "/s?page=2" } };
const PAGE2 = { products: ["b"], pageInfo: { nextPage: undefined } };
const FLAT_NEXT = { products: ["c"], nextPage: "/s?page=2" };

// ---------------------------------------------------------------------------
// getNextPageUrl (pure helper)
// ---------------------------------------------------------------------------

describe("getNextPageUrl", () => {
	it("reads pageInfo.nextPage", () => {
		expect(getNextPageUrl(PAGE1)).toBe("/s?page=2");
	});

	it("returns undefined when pageInfo.nextPage is absent", () => {
		expect(getNextPageUrl(PAGE2)).toBeUndefined();
	});

	it("falls back to flat nextPage", () => {
		expect(getNextPageUrl(FLAT_NEXT)).toBe("/s?page=2");
	});

	it("returns undefined for non-objects", () => {
		expect(getNextPageUrl(null)).toBeUndefined();
		expect(getNextPageUrl("string")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// useLoadMore (actual hook via React render)
// ---------------------------------------------------------------------------

describe("useLoadMore", () => {
	beforeEach(() => {
		vi.stubGlobal("location", { href: "https://site.com/s?q=telha" });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("accumulates pages and flips hasMore off on last page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: async () => PAGE2 })),
		);

		const runner = makeHookRunner(() =>
			useLoadMore(PAGE1, "apps/vtex.ts/loaders/plp.ts"),
		);
		await runner.mount();

		expect(runner.current.pages).toEqual([PAGE1]);
		expect(runner.current.hasMore).toBe(true);

		await act(async () => {
			await runner.current.loadMore();
		});

		expect(runner.current.pages).toEqual([PAGE1, PAGE2]);
		expect(runner.current.hasMore).toBe(false);
		await runner.unmount();
	});

	it("calls /deco/invoke with absolute __pageUrl and __pagePath", async () => {
		const captured: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				captured.push(init.body as string);
				return Promise.resolve({ ok: true, json: async () => PAGE2 });
			}),
		);

		const runner = makeHookRunner(() =>
			useLoadMore(PAGE1, "apps/vtex.ts/loaders/plp.ts"),
		);
		await runner.mount();
		await act(async () => { await runner.current.loadMore(); });

		const body = JSON.parse(captured[0]);
		expect(body.props.__pageUrl).toBe("https://site.com/s?page=2");
		expect(body.props.__pagePath).toBe("/s");
		await runner.unmount();
	});

	it("sets error state on failed invoke, does not throw", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: false, status: 500 })),
		);

		const runner = makeHookRunner(() =>
			useLoadMore(PAGE1, "apps/vtex.ts/loaders/plp.ts"),
		);
		await runner.mount();
		await act(async () => { await runner.current.loadMore(); });

		expect(runner.current.error).toBeInstanceOf(Error);
		expect(runner.current.error?.message).toContain("500");
		// pages unchanged
		expect(runner.current.pages).toEqual([PAGE1]);
		await runner.unmount();
	});

	it("resets pages when resetKey changes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: true, json: async () => PAGE2 })),
		);

		let resetKey = "url-a";
		const runner = makeHookRunner(() =>
			useLoadMore(PAGE1, "apps/vtex.ts/loaders/plp.ts", resetKey),
		);
		await runner.mount();

		// accumulate one page
		await act(async () => { await runner.current.loadMore(); });
		expect(runner.current.pages).toHaveLength(2);

		// simulate filter change: resetKey changes, initial stays PAGE1 for simplicity
		resetKey = "url-b";
		await runner.rerender();

		expect(runner.current.pages).toEqual([PAGE1]);
		expect(runner.current.hasMore).toBe(true);
		await runner.unmount();
	});

	it("prevents double-submission (inflight guard)", async () => {
		let resolveFirst!: () => void;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<{ ok: boolean; json: () => Promise<typeof PAGE2> }>((resolve) => {
						resolveFirst = () => resolve({ ok: true, json: async () => PAGE2 });
					}),
			),
		);

		const runner = makeHookRunner(() =>
			useLoadMore(PAGE1, "apps/vtex.ts/loaders/plp.ts"),
		);
		await runner.mount();

		// fire two rapid clicks (no await between them)
		const p1 = act(async () => { runner.current.loadMore(); });
		const p2 = act(async () => { runner.current.loadMore(); });
		resolveFirst();
		await Promise.all([p1, p2]);

		// fetch must be called only once
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
		await runner.unmount();
	});
});
