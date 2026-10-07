import { beforeEach, describe, expect, it, vi } from "vitest";
import categoriesFixture from "../../__fixtures__/categories.json";
import { clearNuvemshopCache, configureNuvemshop, setNuvemshopFetch } from "../../client";
import { nuvemshopSitemap } from "../sitemap";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const page = (n: number, total: number, handles: string[]) => ({
  data: handles.map((handle, i) => ({
    id: n * 100 + i,
    handle,
    updated_at: `2026-10-0${n}T10:00:00+0000`,
  })),
  pagination: { page: n, per_page: 200, total: 3, total_pages: total },
});

const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/categories")) return json(categoriesFixture);
  const p = Number(url.searchParams.get("page") ?? 1);
  return json(p === 1 ? page(1, 2, ["camisa-a", "camisa-b&c"]) : page(2, 2, ["tenis-x"]));
});

beforeEach(() => {
  fetchMock.mockClear();
  clearNuvemshopCache();
  configureNuvemshop({ storeId: "8336778" });
  setNuvemshopFetch(fetchMock as unknown as typeof fetch);
});

describe("nuvemshopSitemap", () => {
  it("pages through every product and lists categories with nested URLs", async () => {
    const xml = await nuvemshopSitemap({ origin: "https://www.loja.example" });

    const productCalls = fetchMock.mock.calls
      .map(([u]) => new URL(String(u)))
      .filter((u) => u.pathname.endsWith("/products"));
    expect(productCalls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(productCalls[0].searchParams.get("per_page")).toBe("200");
    expect(productCalls[0].searchParams.get("fields")).toBe("handle,updated_at");

    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ),
    ).toBe(true);
    expect(xml).toContain(
      "<url><loc>https://www.loja.example/produtos/camisa-a</loc><lastmod>2026-10-01</lastmod></url>",
    );
    expect(xml).toContain("<loc>https://www.loja.example/produtos/tenis-x</loc>");
    expect(xml).toContain("<loc>https://www.loja.example/produtos/camisa-b&amp;c</loc>"); // XML-escaped
    expect(xml).toContain("<url><loc>https://www.loja.example/calcados/masculino</loc></url>");
    expect(xml).toContain("<url><loc>https://www.loja.example/</loc></url>");
    expect(xml.match(/<url>/g)).toHaveLength(1 + categoriesFixture.data.length + 3);
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });
});
