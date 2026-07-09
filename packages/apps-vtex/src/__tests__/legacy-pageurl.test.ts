/**
 * Regression tests for CMS-block dispatch of the legacy Catalog loaders:
 * `url`/`baseUrl` used to be required props filled by nobody (in deco-cx they
 * came from `req`), so dispatching the loader straight from a CMS block threw.
 * Now they're derived from the resolver-injected `__pageUrl` — these tests
 * pin the derivation and the loud failure when neither source is present.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { configureVtex, setVtexFetch } from "../client";
import {
	legacyProductDetailsPage,
	legacyProductList,
	legacyProductListingPage,
} from "../loaders/legacy";
import type { PageType } from "../utils/types";

function mockResponse(body: unknown, headers: Record<string, string> = {}): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers(headers),
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

const categoryPageType: PageType = {
	id: "42",
	name: "Sapatos",
	url: "loja.com/sapatos",
	title: "Sapatos",
	metaTagDescription: "Sapatos da loja",
	pageType: "Category",
};

const emptyFacets = {
	CategoriesTrees: [],
	Departments: [],
	Brands: [],
	SpecificationFilters: {},
	PriceRanges: [],
};

describe("legacy loaders — url/baseUrl derived from __pageUrl", () => {
	let requestedUrls: string[];

	beforeEach(() => {
		configureVtex({ account: "testaccount" });
		requestedUrls = [];
		setVtexFetch(((url: string) => {
			requestedUrls.push(url);
			if (url.includes("/pub/portal/pagetype/")) {
				return Promise.resolve(mockResponse(categoryPageType));
			}
			if (url.includes("/pub/facets/search/")) {
				return Promise.resolve(mockResponse(emptyFacets));
			}
			if (url.includes("/pub/products/search")) {
				return Promise.resolve(mockResponse([], { resources: "0/0" }));
			}
			return Promise.resolve(mockResponse({}));
		}) as typeof fetch);
	});

	describe("legacyProductListingPage", () => {
		it("resolves url and baseUrl from __pageUrl alone", async () => {
			const page = await legacyProductListingPage({
				__pageUrl: "https://loja.com/sapatos?sort=price:asc",
			});

			expect(page).not.toBeNull();
			expect(page?.["@type"]).toBe("ProductListingPage");

			// Sort came from __pageUrl's search params, map/term from the pagetype.
			const productsCall = requestedUrls.find((u) => u.includes("/pub/products/search/"));
			expect(productsCall).toContain("sapatos");
			expect(productsCall).toContain("O=OrderByPriceASC");
			expect(productsCall).toContain("map=c");

			// baseUrl defaulted to the page URL origin.
			expect(page?.breadcrumb.itemListElement[0]?.item).toBe("https://loja.com/sapatos");
			expect(page?.seo?.canonical).toBe("https://loja.com/sapatos");
		});

		it("prefers an explicit url over __pageUrl", async () => {
			await legacyProductListingPage({
				url: new URL("https://a.com/sapatos?sort=price:desc"),
				__pageUrl: "https://b.com/botas?sort=price:asc",
			});

			const productsCall = requestedUrls.find((u) => u.includes("/pub/products/search/"));
			expect(productsCall).toContain("O=OrderByPriceDESC");
		});

		it("throws a clear error when neither url nor __pageUrl is present", async () => {
			await expect(legacyProductListingPage({})).rejects.toThrow(
				"legacyProductListingPage requires url or __pageUrl",
			);
			expect(requestedUrls).toHaveLength(0);
		});
	});

	describe("legacyProductDetailsPage", () => {
		it("derives baseUrl from __pageUrl alone", async () => {
			// Empty search result → null, but only after the (mocked) fetch ran —
			// proving the loader got past the baseUrl guard without an explicit one.
			const page = await legacyProductDetailsPage({
				slug: "sapato-social",
				__pageUrl: "https://loja.com/sapato-social/p",
			});
			expect(page).toBeNull();
			expect(requestedUrls.some((u) => u.includes("/pub/products/search/sapato-social/p"))).toBe(
				true,
			);
		});

		it("throws a clear error when neither baseUrl nor __pageUrl is present", async () => {
			await expect(legacyProductDetailsPage({ slug: "sapato-social" })).rejects.toThrow(
				"legacyProductDetailsPage requires baseUrl or __pageUrl",
			);
			expect(requestedUrls).toHaveLength(0);
		});
	});

	describe("legacyProductList", () => {
		it("derives baseUrl from __pageUrl alone", async () => {
			const products = await legacyProductList({
				query: { term: "sapato", count: 2 },
				__pageUrl: "https://loja.com/",
			});
			expect(products).toEqual([]);
			expect(requestedUrls.some((u) => u.includes("/pub/products/search/"))).toBe(true);
		});

		it("throws a clear error when neither baseUrl nor __pageUrl is present", async () => {
			await expect(
				legacyProductList({ query: { term: "sapato", count: 2 } }),
			).rejects.toThrow("legacyProductList requires baseUrl or __pageUrl");
			expect(requestedUrls).toHaveLength(0);
		});
	});
});
