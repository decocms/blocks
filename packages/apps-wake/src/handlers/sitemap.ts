import { withFetchTimeout } from "@decocms/blocks/sdk/fetchTimeout";
import { getWakeConfig } from "../client";

const fetchSafe = withFetchTimeout();

const BASE_SITEMAP_URL = "https://p-general-sitemap-public.s3.us-east-2.amazonaws.com/Sitemap";

const xmlHeader = '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

const includeSiteMaps = (currentXML: string, origin: string, includes?: string[]) => {
  const siteMapIncludeTags: string[] = [];

  for (const include of includes ?? []) {
    siteMapIncludeTags.push(`
      <sitemap>
          <loc>${include.startsWith("/") ? `${origin}${include}` : include}</loc>
          <lastmod>${new Date().toISOString().substring(0, 10)}</lastmod>
      </sitemap>
    `);
  }

  return siteMapIncludeTags.length > 0
    ? currentXML.replace(xmlHeader, `${xmlHeader}\n${siteMapIncludeTags.join("\n")}`)
    : currentXML;
};

export interface Props {
  include?: string[];
}

/**
 * @title Sitemap Proxy
 *
 * Returns a request handler that proxies the Wake public S3 sitemap for the
 * configured account, rewriting the public URL to the current origin and
 * optionally injecting extra `<sitemap>` entries.
 */
export default function Sitemap({ include }: Props = {}) {
  return async (req: Request): Promise<Response> => {
    const { account } = getWakeConfig();

    if (!account) {
      throw new Error("Missing account");
    }

    const publicUrl = `${BASE_SITEMAP_URL}/${account}/`;

    const response = await fetchSafe(publicUrl);

    const reqUrl = new URL(req.url);
    const text = await response.text();

    return new Response(
      includeSiteMaps(text.replaceAll(publicUrl, `${reqUrl.origin}/`), reqUrl.origin, include),
      {
        headers: response.headers,
        status: response.status,
      },
    );
  };
}
