import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureVtex } from "../../client";
import { createVtexSitemapProxy, isVtexSitemapPath } from "../sitemap";

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
