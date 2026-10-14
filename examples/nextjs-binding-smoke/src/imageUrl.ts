import { createImageUrl, decoCdn } from "@decocms/blocks/image";

// The next/image storefronts ask the Deco CDN for `fit=contain`. A commerce
// site adds its platform's helpers (`@decocms/apps-vtex/image`, ...) before it.
export const imageUrl = createImageUrl({ providers: [decoCdn({ fit: "contain" })] });
