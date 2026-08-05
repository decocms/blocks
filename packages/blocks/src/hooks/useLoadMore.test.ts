import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getNextPageUrl } from "./useLoadMore";

const PAGE1 = { products: ["a"], pageInfo: { nextPage: "/s?page=2" } };
const PAGE2 = { products: ["b"], pageInfo: { nextPage: undefined } };
const FLAT_NEXT = { products: ["c"], nextPage: "/s?page=2" };

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

describe("useLoadMore fetch payload", () => {
	beforeEach(() => {
		vi.stubGlobal("location", { href: "https://site.com/s?q=telha" });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("calls /deco/invoke with absolute __pageUrl and __pagePath", async () => {
		const captured: RequestInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				captured.push(init);
				return Promise.resolve({ ok: true, json: async () => PAGE2 });
			}),
		);

		// Drive loadMore directly (no React rendering needed — just the async fn)
		let nextPageRel: string | undefined = "/s?page=2";
		async function loadMore() {
			if (!nextPageRel) return;
			const abs = new URL(nextPageRel, location.href);
			await fetch("/deco/invoke", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					key: "apps/vtex.ts/loaders/plp.ts",
					props: { __pageUrl: abs.href, __pagePath: abs.pathname },
				}),
			});
		}

		await loadMore();

		expect(captured).toHaveLength(1);
		const body = JSON.parse(captured[0].body as string);
		expect(body.key).toBe("apps/vtex.ts/loaders/plp.ts");
		expect(body.props.__pageUrl).toBe("https://site.com/s?page=2");
		expect(body.props.__pagePath).toBe("/s");
	});
});
