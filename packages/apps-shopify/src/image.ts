/**
 * `@decocms/apps-shopify/image`: Shopify's CDN image URLs as an
 * `ImageProvider` for `createImageUrl` (`@decocms/blocks/image`). A pure
 * function: no fetch, no React, no module state. List it before `decoCdn`:
 *
 * ```ts
 * import { createImageUrl, decoCdn } from "@decocms/blocks/image";
 * import { shopifyCdn } from "@decocms/apps-shopify/image";
 * export const imageUrl = createImageUrl({ providers: [shopifyCdn(), decoCdn({ sources: "all" })] });
 * ```
 */
import type { ImageProvider } from "@decocms/blocks/image";

/**
 * `https://cdn.shopify.com` images, as v7's `Image` resized them: `width`,
 * `height` (when the call has one) and `crop=center` set on the URL's query;
 * the URL comes back re-serialised by `URL`.
 */
export function shopifyCdn(): ImageProvider {
  return {
    name: "shopify",
    hosts: ["cdn.shopify.com"],
    match: (src) => src.startsWith("https://cdn.shopify.com"),
    format(src, r) {
      const url = new URL(src);
      url.searchParams.set("width", `${r.width}`);
      if (r.height) url.searchParams.set("height", `${r.height}`);
      url.searchParams.set("crop", "center");
      return url.href;
    },
  };
}
