/**
 * Product + category sitemap built from the Storefront API (which has no
 * sitemap endpoint). URLs use the same paths as the loaders (`/produtos/<handle>`,
 * `/<cat>/<sub>`), so they resolve without redirects. Serve it from a site route:
 *
 * ```ts
 * // src/routes/sitemap[.]xml.ts
 * GET: async ({ request }) => new Response(await nuvemshopSitemap({ origin: new URL(request.url).origin }),
 *   { headers: { "content-type": "application/xml; charset=utf-8" } })
 * ```
 */
import { nuvemshopGet } from "../client";
import { categoryChain, categoryPath, productPath } from "./transform";
import type { NuvemshopCategory, NuvemshopList } from "./types";

// ponytail: one request per 200 products, sequential; split into a sitemap index if a catalog
// ever outgrows the 50k-URL sitemap limit.
const PER_PAGE = 200;

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const entry = (loc: string, lastmod?: string) =>
  `<url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ""}</url>`;

export async function nuvemshopSitemap({ origin }: { origin: string }): Promise<string> {
  const urls = [entry(`${origin}/`)];

  const categories =
    (await nuvemshopGet<NuvemshopList<NuvemshopCategory>>("/categories", { per_page: PER_PAGE }))
      ?.data ?? [];
  for (const c of categories)
    urls.push(entry(`${origin}${categoryPath(categoryChain(c, categories))}`));

  for (let page = 1, pages = 1; page <= pages; page++) {
    const list = await nuvemshopGet<NuvemshopList<{ handle: string; updated_at?: string }>>(
      "/products",
      {
        fields: "handle,updated_at",
        per_page: PER_PAGE,
        page,
      },
    );
    if (!list) break;
    pages = list.pagination.total_pages;
    for (const p of list.data) urls.push(entry(`${origin}${productPath(p.handle)}`, p.updated_at));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
