# Components per binding

`@decocms/blocks/image` builds URLs. Each binding turns them into markup its own
way. In every case the binding gets the site's `ImageUrl` (see
[providers-and-cdn.md](./providers-and-cdn.md)); it knows no commerce platform
itself.

## TanStack Start: `@decocms/tanstack/react`

Exports: `Image`, `Picture`, `Source`, `ImageUrlProvider`, `useImageUrl`,
`DECO_IMAGE_URL`, and the prop types `ImageProps`, `PictureProps`,
`SourceProps`. They keep v7's props and markup, so a v7 call site moves by
changing the import.

### Wire the site's `ImageUrl` once

```tsx
// src/router.tsx
import { ImageUrlProvider } from "@decocms/tanstack/react";
import { createDecoRouter } from "@decocms/tanstack/router";
import { imageUrl } from "./imageUrl";

createDecoRouter({
  routeTree,
  Wrap: ({ children }) => <ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider>,
});
```

Without a provider, components use `DECO_IMAGE_URL`:
`createImageUrl({ providers: [decoCdn({ sources: "all" })] })`. That sends
every source, VTEX and Shopify images included, through
`assets.decocms.com` with no quality tier. A storefront almost always wants its
own `imageUrl` with the platform provider first.

`ImageUrlProvider` is a React context. A nested provider overrides it for one
subtree, which is how you give one area a different tier (see
[quality-and-lcp.md](./quality-and-lcp.md)). `useImageUrl()` returns the nearest
one, for code that needs a URL outside the components (a CSS background, an
Open Graph tag).

### `Image`

```tsx
<Image src={src} width={640} height={480} alt={alt} />
```

| Prop | Default | Effect |
|---|---|---|
| `src`, `width` | required | `width` is the 1x width and the base of the srcset. |
| `height` | none | Sent to the provider and set on the `<img>`. |
| `fit` | `"cover"` | Passed to the provider. |
| `preload` | `false` | Renders a `<link rel="preload" as="image">` next to the `<img>`, and sets `loading="eager"` and `fetchPriority="high"`. |
| `media` | none | `media` on that preload link. |
| `sizes` | `"(max-width: 768px) 100vw, 50vw"` when there is a srcset | Override it to match the real layout. |
| `srcSet` | built | Overrides the generated srcset. |
| `loading` | `"lazy"`, or `"eager"` with `preload` | |
| `decoding` | `"async"` | |

Every other `<img>` attribute passes through. There is **no `quality` prop**:
quality comes from the `ImageUrl`.

The generated srcset has two width candidates, `width` and `2 × width`
(`height` scaled the same way), written as `<url> 640w, <url> 1280w`.

### `Picture` and `Source`

Art direction: one `Source` per media query and an `Image` fallback.

```tsx
<Picture preload={isLcp}>
  <Source media="(max-width: 767px)" src={mobile} width={375} height={184} />
  <Source media="(min-width: 768px)" src={desktop} width={1280} height={480} />
  <Image src={desktop} width={1280} height={480} alt={alt} />
</Picture>
```

With `<Picture preload>`, each `Source` renders its own preload link with its
`media`, so the browser preloads only the one that applies. `Source` takes
`src`, `width`, `height`, `fit` (default `"cover"`), `fetchPriority` and any
`<source>` attribute. Do not also set `preload` on the fallback `Image` inside a
preloading `Picture`: that adds a second preload with no `media`.

## Next.js: `@decocms/nextjs/image-loader`

next/image renders the markup; Deco only provides the loader.

```ts
// src/image-loader.ts
import { createDecoImageLoader } from "@decocms/nextjs/image-loader";
import { imageUrl } from "./imageUrl";
export default createDecoImageLoader(imageUrl);
```

```js
// next.config: images: { loader: "custom", loaderFile: "./src/image-loader.ts" }
```

The loader receives `{ src, width, quality }` from next/image:

- If `imageUrl.isOptimizable(src)`, it returns `imageUrl(src, { width, quality })`.
  next/image passes no height or fit, so providers get width only.
- Otherwise it calls `fallback(props)`. With no `fallback`, or one that returns
  `null`, `src` comes back unchanged.

For local `/public` files or other hosts no provider handles, use Next's own
optimizer as the fallback:

```ts
import { createDecoImageLoader, nextImageOptimizer } from "@decocms/nextjs/image-loader";
export default createDecoImageLoader(imageUrl, { fallback: nextImageOptimizer });
```

`nextImageOptimizer` builds `/_next/image?url=&w=&q=`, turning tiers into
60/70/80/100. The host still has to be allowed in `images.remotePatterns`.

Quality: next/image's `quality` prop is a number. `decoCdn` ignores numbers, so
on Deco-CDN images the tier set in `decoCdn({ quality })` decides.
`vtexCatalogWebp` and `vtexFileManager` do read numbers; `vtexCatalog`,
`vtexCatalogFrame` and `shopifyCdn` ignore quality.

`sizes`, priority and preload are next/image's own props; follow the Next.js
docs for your version. Wiring `next.config` is covered in `deco-nextjs-site`.

## Any other renderer: `srcSet` and `preloadLink`

Both take the `ImageUrl` as the first argument.

```ts
import { srcSet, preloadLink, parseSrcSet } from "@decocms/blocks/image";

srcSet(imageUrl, src, { width: 640, height: 480 });          // factors [1, 2]
srcSet(imageUrl, src, { widths: [320, 640, 1280], ratio: 0.75 }); // explicit widths, height = round(w × ratio)
preloadLink(imageUrl, src, { width: 1280, sizes: "100vw", media: "(min-width: 768px)" });
```

- `srcSet` options: `width`, `widths` (wins over `width` and `factors`),
  `factors` (default `[1, 2]`, truncated), `height`, `ratio`, `fit`, `quality`.
  Returns `undefined` for an empty `src` or no candidates. Without `width` or
  `widths` it writes `NaN` candidates, as v7 did: always pass one.
- `preloadLink` returns `{ rel: "preload", as: "image", href, imageSrcSet?,
  imageSizes?, media?, fetchPriority }`, `fetchPriority` defaulting to
  `"high"`. Spread it into a `<link>` or a route's head links.
- `parseSrcSet(s)` splits a srcset attribute into `{ url, w?, x? }`, keeping
  URLs with commas whole. Useful in tests.

## Image fields in section props

The schema generator gives an image picker to a string prop typed with the
alias `ImageWidget`, and a video picker to `VideoWidget`. Both are exported
from `@decocms/compat-v7/types/widgets` (plain `string` aliases).
`@format image-uri` or `@format video-uri` on a string does the same.

```ts
import type { ImageWidget } from "@decocms/compat-v7/types/widgets";

interface Props {
  /** @description Desktop image, at least 2560×960 (2× the 1280×480 slot) */
  image: ImageWidget;
  alt: string;
}
```

`deco check` does not validate these values: `image-uri` and `video-uri` accept
any string, so a broken URL passes the check. Put the 2x pixel size in the
field's `@description` (the generated schema carries it to the editor's form), so
editors upload large enough files. Field annotations in general are in
`deco-cms-schema`.
