import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureVtex } from "../../client";
import {
	createVtexSitemapProxy,
	dropEntriesWithoutPage,
	dropUrlLastmod,
	excludeSitemapEntries,
	includeSitemaps,
	isVtexSitemapPath,
} from "../sitemap";

const ACCOUNT = "myaccount";
const VTEX_HOST = `${ACCOUNT}.vtexcommercestable.com.br`;

beforeEach(() => {
	configureVtex({ account: ACCOUNT });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isVtexSitemapPath", () => {
	it.each([
		["/sitemap.xml", true],
		["/sitemap/products-1.xml", true],
		["/sitemap/category-3.xml", true],
		["/sitemap/", true],
		["/sitemap", false],
		["/", false],
		["/checkout", false],
		["/sitemap-busca.xml", false],
	])("%s → %s", (pathname, expected) => {
		expect(isVtexSitemapPath(pathname)).toBe(expected);
	});
});

describe("createVtexSitemapProxy", () => {
	function makeFetch(
		responseBody: string,
		init: { status?: number; ok?: boolean } = {},
	): typeof fetch {
		const status = init.status ?? 200;
		return vi.fn(
			async () =>
				new Response(responseBody, {
					status,
					headers: { "content-type": "application/xml" },
				}),
		) as unknown as typeof fetch;
	}

	const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://${VTEX_HOST}/sitemap/products-1.xml</loc></sitemap>
  <sitemap><loc>https://${VTEX_HOST}/sitemap/category-1.xml</loc></sitemap>
</sitemapindex>`;

	const PRODUCT_SUB_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://${VTEX_HOST}/p/some-product/p</loc></url>
</urlset>`;

	it("returns null for non-sitemap paths", async () => {
		const proxy = createVtexSitemapProxy({ fetchImpl: makeFetch("") });
		const url = new URL("https://www.mystore.com/checkout");
		await expect(proxy(new Request(url), url)).resolves.toBeNull();
	});

	it("proxies /sitemap.xml and rewrites VTEX hostname to storefront origin", async () => {
		const fetchImpl = makeFetch(SITEMAP_INDEX);
		const proxy = createVtexSitemapProxy({ fetchImpl });
		const url = new URL("https://www.mystore.com/sitemap.xml");

		const res = await proxy(new Request(url), url);

		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		expect(res!.headers.get("content-type")).toBe("application/xml; charset=utf-8");
		expect(fetchImpl).toHaveBeenCalledWith(`https://${VTEX_HOST}/sitemap.xml`);

		const xml = await res!.text();
		expect(xml).not.toContain(VTEX_HOST);
		expect(xml).toContain("https://www.mystore.com/sitemap/products-1.xml");
		expect(xml).toContain("https://www.mystore.com/sitemap/category-1.xml");
	});

	it("proxies /sitemap/* sub-sitemaps with hostname rewrite", async () => {
		const fetchImpl = makeFetch(PRODUCT_SUB_SITEMAP);
		const proxy = createVtexSitemapProxy({ fetchImpl });
		const url = new URL("https://www.mystore.com/sitemap/products-1.xml");

		const res = await proxy(new Request(url), url);

		expect(res).not.toBeNull();
		expect(fetchImpl).toHaveBeenCalledWith(`https://${VTEX_HOST}/sitemap/products-1.xml`);
		const xml = await res!.text();
		expect(xml).toContain("https://www.mystore.com/p/some-product/p");
		expect(xml).not.toContain(VTEX_HOST);
	});

	it("injects extraSitemaps entries into /sitemap.xml only", async () => {
		const fetchImpl = makeFetch(SITEMAP_INDEX);
		const proxy = createVtexSitemapProxy({
			fetchImpl,
			extraSitemaps: ["/sitemap-busca.xml", "extra-bare", "https://cdn.example.com/static.xml"],
		});
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const xml = await (await proxy(new Request(url), url))!.text();

		expect(xml).toContain("<loc>https://www.mystore.com/sitemap-busca.xml</loc>");
		expect(xml).toContain("<loc>https://www.mystore.com/extra-bare</loc>");
		expect(xml).toContain("<loc>https://cdn.example.com/static.xml</loc>");
		// Extra entries are inserted before the closing tag (i.e. inside the index).
		expect(xml.indexOf("sitemap-busca.xml")).toBeLessThan(xml.indexOf("</sitemapindex>"));
	});

	it("does not inject extraSitemaps into sub-sitemaps", async () => {
		const fetchImpl = makeFetch(PRODUCT_SUB_SITEMAP);
		const proxy = createVtexSitemapProxy({
			fetchImpl,
			extraSitemaps: ["/sitemap-busca.xml"],
		});
		const url = new URL("https://www.mystore.com/sitemap/products-1.xml");
		const xml = await (await proxy(new Request(url), url))!.text();

		expect(xml).not.toContain("sitemap-busca.xml");
	});

	it("returns 502 when VTEX origin returns non-OK", async () => {
		const fetchImpl = makeFetch("upstream is down", { status: 503 });
		const proxy = createVtexSitemapProxy({ fetchImpl });
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const res = await proxy(new Request(url), url);
		expect(res!.status).toBe(502);
	});

	it("returns 502 when fetch throws", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const proxy = createVtexSitemapProxy({ fetchImpl });
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const res = await proxy(new Request(url), url);
		expect(res!.status).toBe(502);
	});

	it("uses the configured environment", async () => {
		const fetchImpl = makeFetch(SITEMAP_INDEX);
		const proxy = createVtexSitemapProxy({
			fetchImpl,
			environment: "vtexcommercebeta",
		});
		const url = new URL("https://www.mystore.com/sitemap.xml");
		await proxy(new Request(url), url);

		expect(fetchImpl).toHaveBeenCalledWith(
			`https://${ACCOUNT}.vtexcommercebeta.com.br/sitemap.xml`,
		);
	});

	it("honors a custom Cache-Control header", async () => {
		const fetchImpl = makeFetch(SITEMAP_INDEX);
		const proxy = createVtexSitemapProxy({
			fetchImpl,
			cacheControl: "public, max-age=60",
		});
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const res = await proxy(new Request(url), url);
		expect(res!.headers.get("cache-control")).toBe("public, max-age=60");
	});

	it("emits the default Cache-Control by default", async () => {
		const fetchImpl = makeFetch(SITEMAP_INDEX);
		const proxy = createVtexSitemapProxy({ fetchImpl });
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const res = await proxy(new Request(url), url);
		expect(res!.headers.get("cache-control")).toBe(
			"public, s-maxage=3600, stale-while-revalidate=86400",
		);
	});

	it("respects non-default VTEX domain (e.g. .com)", async () => {
		configureVtex({ account: ACCOUNT, domain: "com" });
		const fetchImpl = makeFetch(SITEMAP_INDEX);
		const proxy = createVtexSitemapProxy({ fetchImpl });
		const url = new URL("https://www.mystore.com/sitemap.xml");
		await proxy(new Request(url), url);

		expect(fetchImpl).toHaveBeenCalledWith(`https://${ACCOUNT}.vtexcommercestable.com/sitemap.xml`);
	});
});

// deco-cx `vtex/handlers/sitemap.ts` options (`include`, `excludeSiteMapEntry`,
// `removeEntriesWithoutPage`, `removeUrlLastmod`). A Fresh site's `site.json`
// carries them; without them the proxied index listed the storefront's own
// sitemaps last and undated, every `<url>` kept VTEX's generation-date
// `<lastmod>`, and categories with no page were announced only to answer 404.
describe("createVtexSitemapProxy — deco-cx handler options", () => {
	const today = new Date().toISOString().substring(0, 10);

	function makeFetch(responseBody: string): typeof fetch {
		return vi.fn(
			async () =>
				new Response(responseBody, { status: 200, headers: { "content-type": "application/xml" } }),
		) as unknown as typeof fetch;
	}

	const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://${VTEX_HOST}/sitemap/products-1.xml</loc><lastmod>2024-01-01</lastmod></sitemap>
  <sitemap><loc>https://${VTEX_HOST}/sitemap/brand-0.xml</loc></sitemap>
  <sitemap><loc>https://${VTEX_HOST}/sitemap/custom-user-routes-1.xml</loc></sitemap>
</sitemapindex>`;

	const CATEGORIES = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://${VTEX_HOST}/roupas</loc><lastmod>2024-01-01</lastmod></url>
  <url><loc>https://${VTEX_HOST}/roupas/intimos/pijamas</loc><lastmod>2024-01-01</lastmod></url>
  <url><loc>https://${VTEX_HOST}/s?q=a&amp;b=2</loc></url>
  <url><loc>https://${VTEX_HOST}/camisa-paris/p</loc></url>
  <url><loc>https://${VTEX_HOST}/checkout/cart</loc></url>
</urlset>`;

	it("include: inserted right after <sitemapindex>, in order, dated today", async () => {
		const proxy = createVtexSitemapProxy({
			fetchImpl: makeFetch(INDEX),
			include: ["/sitemap/the-post-posts.xml", "/sitemap/deco.xml"],
		});
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const xml = await (await proxy(new Request(url), url))!.text();

		const posts = xml.indexOf("https://www.mystore.com/sitemap/the-post-posts.xml");
		const deco = xml.indexOf("https://www.mystore.com/sitemap/deco.xml");
		const vtex = xml.indexOf("https://www.mystore.com/sitemap/products-1.xml");
		expect(posts).toBeGreaterThan(xml.indexOf("<sitemapindex"));
		expect(posts).toBeLessThan(deco);
		expect(deco).toBeLessThan(vtex);
		expect(xml).toContain(
			`<loc>https://www.mystore.com/sitemap/deco.xml</loc>\n    <lastmod>${today}</lastmod>`,
		);
	});

	it("include: an absolute URL is used as-is; extraSitemaps still appends undated at the bottom", async () => {
		const proxy = createVtexSitemapProxy({
			fetchImpl: makeFetch(INDEX),
			include: ["https://cdn.example.com/static.xml"],
			extraSitemaps: ["/sitemap-busca.xml"],
		});
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const xml = await (await proxy(new Request(url), url))!.text();

		expect(xml.indexOf("https://cdn.example.com/static.xml")).toBeLessThan(xml.indexOf("products-1.xml"));
		expect(xml.indexOf("sitemap-busca.xml")).toBeGreaterThan(xml.indexOf("products-1.xml"));
		expect(xml).toMatch(/sitemap-busca\.xml<\/loc>\n  <\/sitemap>/);
	});

	it("excludeSiteMapEntry: drops a <sitemap> whose <loc> contains or ends with an entry", async () => {
		const proxy = createVtexSitemapProxy({
			fetchImpl: makeFetch(INDEX),
			excludeSiteMapEntry: ["/custom-user-routes-1.xml", "brand-0.xml"],
		});
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const xml = await (await proxy(new Request(url), url))!.text();

		expect(xml).not.toContain("custom-user-routes-1.xml");
		expect(xml).not.toContain("brand-0.xml");
		expect(xml).toContain("products-1.xml");
		expect(xml.match(/<sitemap>/g)).toHaveLength(1);
	});

	it("removeUrlLastmod: drops <lastmod> from every <url> of a sub-sitemap, not from the index", async () => {
		const sub = createVtexSitemapProxy({ fetchImpl: makeFetch(CATEGORIES), removeUrlLastmod: true });
		const subUrl = new URL("https://www.mystore.com/sitemap/category-0.xml");
		const subXml = await (await sub(new Request(subUrl), subUrl))!.text();
		expect(subXml).not.toContain("<lastmod>");
		expect(subXml.match(/<url>/g)).toHaveLength(5);

		const index = createVtexSitemapProxy({ fetchImpl: makeFetch(INDEX), removeUrlLastmod: true });
		const indexUrl = new URL("https://www.mystore.com/sitemap.xml");
		const indexXml = await (await index(new Request(indexUrl), indexUrl))!.text();
		expect(indexXml).toContain("<lastmod>2024-01-01</lastmod>");
	});

	it("removeEntriesWithoutPage: keeps only the <url>s a CMS page or servesPath answers", async () => {
		const proxy = createVtexSitemapProxy({
			fetchImpl: makeFetch(CATEGORIES),
			removeEntriesWithoutPage: {
				pagePaths: () => ["/roupas", "/s", "/:slug/p", "/*"],
				servesPath: (p) => p.startsWith("/checkout"),
			},
		});
		const url = new URL("https://www.mystore.com/sitemap/category-0.xml");
		const xml = await (await proxy(new Request(url), url))!.text();

		expect(xml).toContain("https://www.mystore.com/roupas</loc>");
		// The catch-all 404 page does not count as answering.
		expect(xml).not.toContain("/roupas/intimos/pijamas");
		// Entity-encoded query strings are decoded before the path is read.
		expect(xml).toContain("/s?q=a&amp;b=2");
		// A pattern page answers.
		expect(xml).toContain("/camisa-paris/p");
		// A path served outside the CMS answers through `servesPath`.
		expect(xml).toContain("/checkout/cart");
	});

	it("removeEntriesWithoutPage: a sitemap index is never filtered", async () => {
		const proxy = createVtexSitemapProxy({
			fetchImpl: makeFetch(INDEX),
			removeEntriesWithoutPage: { pagePaths: () => ["/"] },
		});
		const url = new URL("https://www.mystore.com/sitemap.xml");
		const xml = await (await proxy(new Request(url), url))!.text();
		expect(xml.match(/<sitemap>/g)).toHaveLength(3);
	});

	it("removeEntriesWithoutPage: with no page to compare against, the sitemap is kept whole", async () => {
		const proxy = createVtexSitemapProxy({
			fetchImpl: makeFetch(CATEGORIES),
			removeEntriesWithoutPage: { pagePaths: () => [] },
		});
		const url = new URL("https://www.mystore.com/sitemap/category-0.xml");
		const xml = await (await proxy(new Request(url), url))!.text();
		expect(xml.match(/<url>/g)).toHaveLength(5);
	});

	it("removeEntriesWithoutPage: a catch-all PLP drops every category unless servesPath vouches for it", async () => {
		const url = new URL("https://www.mystore.com/sitemap/category-0.xml");
		const bare = createVtexSitemapProxy({
			fetchImpl: makeFetch(CATEGORIES),
			removeEntriesWithoutPage: { pagePaths: () => ["/s", "/*"] },
		});
		const dropped = await (await bare(new Request(url), url))!.text();
		expect(dropped).not.toContain("/roupas</loc>");

		const vouched = createVtexSitemapProxy({
			fetchImpl: makeFetch(CATEGORIES),
			removeEntriesWithoutPage: { pagePaths: () => ["/s", "/*"], servesPath: (p) => p.startsWith("/roupas") },
		});
		const kept = await (await vouched(new Request(url), url))!.text();
		expect(kept).toContain("/roupas</loc>");
		expect(kept).toContain("/roupas/intimos/pijamas");
	});

	it("removeEntriesWithoutPage: a literal page path with non-ASCII characters answers its encoded URL", async () => {
		const xml = `<urlset><url><loc>https://www.mystore.com/acess%C3%B3rios</loc></url></urlset>`;
		expect(dropEntriesWithoutPage(xml, { pagePaths: () => ["/acessórios", "/s"] })).toBe(xml);
	});

	it("removeEntriesWithoutPage: compiles each page once per sitemap, not once per entry", async () => {
		const Real = (globalThis as { URLPattern?: new (i: { pathname: string }) => unknown }).URLPattern!;
		let compiled = 0;
		vi.stubGlobal(
			"URLPattern",
			class extends (Real as new (i: { pathname: string }) => object) {
				constructor(init: { pathname: string }) {
					super(init);
					compiled++;
				}
			},
		);
		try {
			const urls = Array.from({ length: 500 }, (_, i) => `<url><loc>https://a.com/c-${i}/x</loc></url>`).join("");
			dropEntriesWithoutPage(`<urlset>${urls}</urlset>`, { pagePaths: () => ["/:a/p", "/:a/:b/p", "/s"] });
			expect(compiled).toBe(3);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("defaults off: the proxied document is byte-identical apart from the host rewrite", async () => {
		const proxy = createVtexSitemapProxy({ fetchImpl: makeFetch(CATEGORIES) });
		const url = new URL("https://www.mystore.com/sitemap/category-0.xml");
		const xml = await (await proxy(new Request(url), url))!.text();
		expect(xml).toBe(CATEGORIES.replaceAll(`https://${VTEX_HOST}`, "https://www.mystore.com"));
	});
});

describe("sitemap helpers", () => {
	it("includeSitemaps/excludeSitemapEntries/dropUrlLastmod are no-ops with nothing to do", () => {
		const xml = "<sitemapindex><sitemap><loc>https://a/x.xml</loc></sitemap></sitemapindex>";
		expect(includeSitemaps(xml, "https://a", [])).toBe(xml);
		expect(excludeSitemapEntries(xml, [])).toBe(xml);
		expect(dropUrlLastmod(xml)).toBe(xml);
	});

	it("dropEntriesWithoutPage keeps an unparseable <loc>", () => {
		const xml = "<urlset><url><loc>not a url</loc></url></urlset>";
		expect(dropEntriesWithoutPage(xml, { pagePaths: () => ["/"] })).toBe(xml);
	});
});

// `utils/sitemap.ts` is re-exported by the `@decocms/apps-vtex/utils` barrel,
// which client components import (slugify, cookies, transform…). The page
// list is injected (`removeEntriesWithoutPage.pagePaths`) precisely so this
// module never pulls the server-only CMS barrel — `@decocms/blocks/cms`
// evaluates `loader.ts` (`node:async_hooks`) and the whole resolver.
describe("sitemap module graph", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const esbuildBin = join(here, "../../../../../node_modules/.bin/esbuild");
	const inputsOf = (entry: string) => {
		const meta = join(here, `.meta-${process.pid}.json`);
		execFileSync(
			esbuildBin,
			[entry, "--bundle", "--platform=node", "--format=esm", "--outfile=/dev/null", `--metafile=${meta}`, "--log-level=error"],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		try {
			return Object.keys(JSON.parse(readFileSync(meta, "utf-8")).inputs as Record<string, unknown>);
		} finally {
			execFileSync("rm", ["-f", meta]);
		}
	};

	it("does not import the server-only CMS barrel", () => {
		const inputs = inputsOf(join(here, "../sitemap.ts"));
		expect(inputs.some((p) => p.endsWith("blocks/src/cms/loader.ts"))).toBe(false);
		expect(inputs.some((p) => p.endsWith("blocks/src/cms/index.ts"))).toBe(false);
	});

	it("sanity check: the CMS barrel does pull loader.ts, so the test above discriminates", () => {
		const inputs = inputsOf(join(here, "../../../../blocks/src/cms/index.ts"));
		expect(inputs.some((p) => p.endsWith("blocks/src/cms/loader.ts"))).toBe(true);
	});
});
