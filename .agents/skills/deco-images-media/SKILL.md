---
name: deco-images-media
description: "Images and video on @decocms/blocks 8 sites. Covers @decocms/blocks/image (createImageUrl, ImageProvider, decoCdn with domain, quality, sources and legacyHosts; srcSet and preloadLink), platform providers listed before decoCdn (vtexCatalog and the other @decocms/apps-vtex/image providers, shopifyCdn from @decocms/apps-shopify/image), Image, Picture, Source and ImageUrlProvider from @decocms/tanstack/react, createDecoImageLoader for next/image from @decocms/nextjs/image-loader, quality tiers, sizes and LCP preload, video served by the Deco media host (audio stripped unless ?muted=false) with a plain <video>, and the v8 asset upload endpoint plus the procedure for moving assets to a new host and rewriting their URLs in .deco/blocks. Load it when images are blurry, slow, oversized or broken, when wiring images on a new v8 site, when a video has no sound, or for an asset migration."
---

# Images and media on v8 sites

A v8 site builds **one `ImageUrl`** from a list of providers and hands it to its
binding. Every resized URL on the site comes from that one function. Most image
bugs on v8 come from three places: the provider list (a source no provider
matches is passed through at full size), the quality tier the Deco CDN is asked
for, and an uploaded source that is smaller than the slot needs.

```ts
// src/imageUrl.ts — one per site
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { vtexCatalog } from "@decocms/apps-vtex/image";

export const imageUrl = createImageUrl({
  providers: [vtexCatalog(), decoCdn({ sources: "all", quality: "high" })],
});
```

Providers are tried in order. The first one whose `match(src)` is true and whose
`format` returns a URL wins. Empty `src` gives `""`; `data:` URIs and sources
no provider matches come back unchanged.

## When to load what

| Reference | Load it when |
|---|---|
| [`providers-and-cdn.md`](./references/providers-and-cdn.md) | Writing `imageUrl`, choosing `decoCdn` options, adding a VTEX or Shopify provider, writing a provider for another platform, CSP `img-src` |
| [`components-per-binding.md`](./references/components-per-binding.md) | Rendering images: `Image`/`Picture`/`Source` on TanStack, the next/image loader on Next.js, `srcSet`/`preloadLink` anywhere else; image fields in section props |
| [`quality-and-lcp.md`](./references/quality-and-lcp.md) | Picking quality tiers, per-image quality, `sizes`, preloading the LCP image |
| [`troubleshooting.md`](./references/troubleshooting.md) | Images are soft, pixelated, too heavy, 404/508, not resized, or shift the layout |
| [`video.md`](./references/video.md) | A video has no sound, autoplay does not start, or you are adding a video field |
| [`asset-upload.md`](./references/asset-upload.md) | Uploads from the site editor, or moving assets off an old host and rewriting URLs in `.deco/blocks` |

## Rules that hold everywhere

- **One `ImageUrl` per site.** v7's `registerImageCdnDomain` and
  `registerImageQuality` are gone. Their values are now `decoCdn({ domain, quality })`.
- **Platform providers go before `decoCdn`.** A provider with `sources: "all"`
  matches every source, so anything listed after it never runs.
- **`decoCdn()` with no `sources` only resizes Deco-hosted URLs.** Other hosts
  pass through at full size. The TanStack default (`DECO_IMAGE_URL`) uses
  `sources: "all"`.
- **Quality on the Deco CDN is a tier name.** It ignores numbers.
- **Set `width` and `height`** on every image, so the browser reserves the box.
- **Preload one image per page**, the LCP one. Preloading more images makes them
  compete for bandwidth.
- **Never send a video through `ImageUrl`.** `decoCdn` builds an `/image?…` URL
  and drops the source's query string, `?muted=false` included.

## Related skills

- `deco-tanstack-site` and `deco-nextjs-site`: where the binding is wired (root
  document, `next.config`, CSP).
- `deco-cms-schema`: field annotations and help text editors see.
- `deco-site-workflow`: `deco pull`, `diff`, `push --draft`, `check`, `publish`.
- `deco-storefront-performance`: LCP and CLS beyond images.
- `deco-v7-to-v8-migration`: moving a v7 image helper to `createImageUrl`.
- `image-optimizer` (decocms/skills): generic HTML image practice (`srcset`,
  `sizes`, `fetchpriority`, formats).
