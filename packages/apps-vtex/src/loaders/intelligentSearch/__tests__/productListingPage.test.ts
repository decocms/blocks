import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureVtex, getInvalidPageNotFound, setInvalidPageNotFound, setVtexFetch } from "../../../client";
import { clearFetchCache } from "../../../utils/fetchCache";
import vtexProductListingPage, { mapLabelledFuzzyToFuzzy, resolvePage } from "../productListingPage";

describe("mapLabelledFuzzyToFuzzy", () => {
	it("translates 'automatic' to 'auto'", () => {
		expect(mapLabelledFuzzyToFuzzy("automatic")).toBe("auto");
	});

	it("translates 'enabled' to '1'", () => {
		expect(mapLabelledFuzzyToFuzzy("enabled")).toBe("1");
	});

	it("translates 'disabled' to '0'", () => {
		expect(mapLabelledFuzzyToFuzzy("disabled")).toBe("0");
	});

	it("returns undefined for missing label", () => {
		expect(mapLabelledFuzzyToFuzzy(undefined)).toBeUndefined();
	});
});

describe("resolvePage (#391)", () => {
	it("defaults to page 0 with no props.page and no URL page", () => {
		expect(resolvePage(undefined, undefined)).toBe(0);
	});

	it("converts a 1-indexed URL ?page= to the 0-indexed internal page", () => {
		expect(resolvePage(undefined, "3")).toBe(2);
	});

	it("uses props.page directly (already 0-indexed) over the URL", () => {
		expect(resolvePage(5, "3")).toBe(5);
	});

	it("coerces a string props.page instead of silently falling back to 0", () => {
		expect(resolvePage("3", undefined)).toBe(3);
	});

	it("falls through to the URL page when props.page is a non-finite string", () => {
		expect(resolvePage("not-a-number", "3")).toBe(2);
	});

	it("floors a fractional props.page and never returns a negative page", () => {
		expect(resolvePage(2.7, undefined)).toBe(2);
		expect(resolvePage(-1, undefined)).toBe(0);
	});
});

// Default: a ?page= that names no page is clamped to the first page — what
// sites already on @decocms/* serve. Pinned against the implementation this
// replaced, so turning the opt-in on for one site changes nothing for others.
describe("resolvePage — default keeps clamping an invalid ?page=", () => {
	// Verbatim from main before the opt-in existed.
	const before = (propsPage: number | string | undefined, pageFromUrl: string | null | undefined) => {
		const coercedPropsPage = propsPage !== undefined ? Number(propsPage) : undefined;
		const rawPage =
			coercedPropsPage !== undefined && Number.isFinite(coercedPropsPage)
				? coercedPropsPage
				: pageFromUrl
					? Number(pageFromUrl) - 1
					: 0;
		return Number.isFinite(rawPage) && rawPage >= 0 ? Math.floor(rawPage) : 0;
	};

	it("answers exactly as before for every URL and CMS combination", () => {
		const urls = [undefined, null, "", "0", "-1", "abc", "NaN", "1", "2", "1.5", "2.5", " ", "01", "+2", "1e1", "0x2", "Infinity", "99999999"];
		const props = [undefined, 0, 2, -1, 2.7, "3", "not-a-number", ""];
		for (const p of props) {
			for (const u of urls) {
				expect(resolvePage(p, u), `props=${String(p)} url=${String(u)}`).toBe(before(p, u));
			}
		}
	});

	it.each(["0", "-1", "abc", "NaN"])("?page=%s → first page", (raw) => {
		expect(resolvePage(undefined, raw)).toBe(0);
	});
});

// Opt-in (`setInvalidPageNotFound(true)`): deco-cx's `pageOf` sends
// `Number(page) - 1` to Intelligent Search without a clamp; IS rejects a page
// below 1 and the PLP answers 404. Clamping to the first page served page 1 as
// an indexable duplicate under `?page=0`.
describe("resolvePage — with notFoundOnInvalid, a ?page= that names no page is not found", () => {
	it.each([
		["0", "?page=0"],
		["-1", "?page=-1"],
		["abc", "?page=abc"],
		["NaN", "?page=NaN"],
	])("%s → null (%s)", (raw) => {
		expect(resolvePage(undefined, raw, true)).toBeNull();
	});

	it("an empty ?page= is still the first page", () => {
		expect(resolvePage(undefined, "", true)).toBe(0);
	});

	it("?page=1 is the first page", () => {
		expect(resolvePage(undefined, "1", true)).toBe(0);
	});

	it("floors a fractional ?page=, which deco-cx accepts", () => {
		expect(resolvePage(undefined, "1.5", true)).toBe(0);
		expect(resolvePage(undefined, "2.5", true)).toBe(1);
	});

	it("a CMS props.page wins over an invalid ?page=", () => {
		expect(resolvePage(2, "0", true)).toBe(2);
	});

	it("a non-numeric props.page still falls through to the URL — and to its verdict", () => {
		expect(resolvePage("not-a-number", "0", true)).toBeNull();
	});
});

describe("vtexProductListingPage — invalid ?page=", () => {
	let isPages: string[];

	beforeEach(() => {
		clearFetchCache();
		configureVtex({ account: "testaccount" });
		isPages = [];
		setVtexFetch(((url: string) => {
			const page = new URL(url).searchParams.get("page");
			if (page !== null) isPages.push(page);
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: () => Promise.resolve({ products: [], recordsFiltered: 0, facets: [] }),
			} as Response);
		}) as typeof fetch);
	});

	afterEach(() => {
		setInvalidPageNotFound(false);
		setVtexFetch(globalThis.fetch);
	});

	it("is off by default", () => {
		expect(getInvalidPageNotFound()).toBe(false);
	});

	it("by default asks Intelligent Search for the first page", async () => {
		await vtexProductListingPage({ query: "camisa", __pageUrl: "/s?q=camisa&page=0" });
		expect(isPages).toContain("1");
	});

	it("with setInvalidPageNotFound(true) returns null without calling Intelligent Search", async () => {
		setInvalidPageNotFound(true);
		const result = await vtexProductListingPage({ query: "camisa", __pageUrl: "/s?q=camisa&page=0" });
		expect(result).toBeNull();
		expect(isPages).toEqual([]);
	});
});
