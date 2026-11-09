# Quality tiers, sizes and the LCP image

## Tiers

The Deco CDN takes four named tiers. Other code in the packages maps them to
percentages:

| Tier | Percent (VTEX providers, `nextImageOptimizer`) |
|---|---|
| `low` | 60 |
| `medium` | 70 |
| `high` | 80 |
| `original` | 100 |

With no tier, `decoCdn` sends no `quality` parameter and the CDN applies its own
default (60% per the comment in `image.ts`). So a site that never sets a tier
gets the lowest one on every Deco-CDN image.

## Where quality is set

| Level | How | Notes |
|---|---|---|
| Whole site | `decoCdn({ quality: "high" })` in the site's `imageUrl` | The usual place. This is v7's `registerImageQuality`. |
| One subtree (TanStack) | A nested `<ImageUrlProvider value={otherImageUrl}>` built with another tier | `Image`, `Picture` and `Source` have no `quality` prop. |
| One URL | `imageUrl(src, { width, quality: "original" })`, `srcSet(imageUrl, src, { …, quality })`, `preloadLink(…, { quality })` | A call's tier wins over the `decoCdn` option. Numbers are ignored by `decoCdn`. |
| next/image | `decoCdn({ quality })` | next/image's numeric `quality` is ignored by `decoCdn`; VTEX providers read it. |

The "Default Image Quality" field of the Fresh-era website app has no v8
equivalent. Quality is code. To let editors change it, read a value from a
settings block and build the `ImageUrl` from it; that is site code, not a
package feature.

Choosing a tier:

- `high` for product photos, hero banners, anything people zoom into.
- `medium` is a fair balance for thumbnails and grids.
- `low` shows visible artifacts on product photography. Avoid it as a
  site-wide value.
- `original` adds bytes, not detail. A source that is too small stays blurry
  at any tier (see [troubleshooting.md](./troubleshooting.md)).

## `sizes` and the srcset

`Image` and `Source` emit two width candidates: `width` and `2 × width`. The
browser picks one using `sizes`. When `sizes` is not set, `Image` uses
`"(max-width: 768px) 100vw, 50vw"`.

That default fits a two-column layout. For a full-width hero on desktop it
tells the browser the image is half the viewport, so it may pick the smaller
candidate and the hero looks soft on large screens. Set `sizes` to the slot's
real width, e.g. `sizes="100vw"` for a full-bleed banner, or
`"(max-width: 768px) 100vw, 1280px"` for a fixed container.

If one slot spans many widths (fluid grids), pass explicit candidates instead
of factors: `srcSet={srcSet(useImageUrl(), src, { widths: [360, 720, 1080, 1440], ratio: 0.5 })}`.

## Preloading the LCP image

Preload exactly one image per page: the one that is the Largest Contentful
Paint on first view. Usually the first hero banner or the main product photo.

- TanStack, one image: `<Image preload … />`. It renders a preload link,
  `loading="eager"` and `fetchPriority="high"`.
- TanStack, art-directed: `<Picture preload>` with a `Source` per media query.
  Each `Source` preloads with its own `media`, so a phone does not download the
  desktop banner.
- Head links: `preloadLink(imageUrl, src, { width, sizes, media })` returns the
  attributes for a `<link>` in the route's head.
- Next.js: use next/image's own preload or priority option.

Rules:

- **Preload only what renders above the fold on first load.** A preload for a
  carousel's second slide or a below-the-fold section wastes bandwidth the LCP
  image needs.
- **Make the preload match the `<img>`.** Same `src`, same `width`/`height`,
  same `sizes`. Otherwise the browser downloads two files. `Image` and `Source`
  build both from the same props, so this holds as long as you do not also
  write a manual preload.
- **Sections decide preload from props.** A banner section usually takes a
  `preload` or "is LCP" boolean, set on the first instance in the page. Do not
  hardcode `preload` in a component that appears many times.
- **Never lazy-load the LCP image.** `loading="lazy"` on it delays LCP. `Image`
  defaults to lazy unless `preload` is set.
- **Always set `width` and `height`.** They give the box its aspect ratio
  before the file arrives, which avoids layout shift.

For measuring LCP and CLS on a page, and fixes beyond images, load
`deco-storefront-performance`. Generic HTML guidance (formats, `fetchpriority`,
media-specific preloads) is in `image-optimizer` (decocms/skills).
