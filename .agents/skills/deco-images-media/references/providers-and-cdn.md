# Providers and the Deco image CDN

`@decocms/blocks/image` is pure functions: no React, no framework, no module
state. A site composes an `ImageUrl` from `ImageProvider`s and passes it to its
binding (see [components-per-binding.md](./components-per-binding.md)).

## The pieces

```ts
interface ResizeOptions { width: number; height?: number; fit?: Fit; quality?: Quality }
type Fit = "contain" | "cover" | "fill";
type Quality = "low" | "medium" | "high" | "original" | number;

interface ImageProvider {
  name: string;
  match(src: string): boolean;                          // does this provider handle src?
  format(src: string, o: ResizeOptions): string | null; // null: leave src to the next provider
  hosts?: string[];                                     // hosts its URLs point at
}

const imageUrl = createImageUrl({ providers: [/* in order */] });
imageUrl(src, { width: 640 });  // resized URL
imageUrl.isOptimizable(src);    // some provider matches (false for "", data:, unknown)
imageUrl.hosts();               // every provider's hosts, deduplicated
```

Order matters. `createImageUrl` walks the list, skips providers whose `match`
is false, and returns the first non-null `format`. Put the narrow providers
(platform catalogs) first and the broad one (`decoCdn({ sources: "all" })`) last.

## `decoCdn(options)`

Builds `https://<domain>/image?fit=&width=[&height=][&quality=]&src=<path>`.

| Option | Default | What it does |
|---|---|---|
| `domain` | `"assets.decocms.com"` | CDN host. `decoims.com` and `deco-assets.edgedeco.com` serve the same endpoint. A scheme or trailing slash is stripped. |
| `quality` | none | Tier used when a call names none. Without it, no `quality` param is sent and the CDN uses its own default (60% per the code's comment). |
| `fit` | `"cover"` | Fit when a call names none. |
| `sources` | `"deco"` | Which sources it resizes. `"deco"`: the Deco asset hosts, `domain` and `legacyHosts`. `"all"`: any non-empty, non-`data:` source. Or a predicate `(src) => boolean`. |
| `legacyHosts` | `["decoims.com"]` when `domain` is `assets.decocms.com`, else `[]` | Older CDN hosts whose URLs are re-served from `domain`. |
| `stripAssetHosts` | `"leading"` | How `https://assets.decocache.com/` and the `deco-sites-assets` S3 bucket prefix are removed from the source. `"leading"`: only when the source starts with one. `"anywhere"`: the first occurrence of each, wherever it is. |
| `layout` | `"src-last"` | Query order. `"quality-last"` matches what next/image loaders built on v7's helper wrote. Keep the one the site used before, so the CDN cache stays warm. |

Behaviour worth knowing:

- **The source's query string is dropped.** `decoCdn` keeps only the part of
  `src` before `?`.
- **Already-resized URLs are unwrapped.** A source that is itself a Deco CDN
  `/image?…&src=…` URL (on any of its hosts) is re-resized from its inner `src`.
  Resizing twice gives the same URL.
- **Self-fetch loop on Cloudflare hosts.** On `assets.decocms.com` and
  `decoims.com`, a `decoims.com` source is stripped to its path. The code notes
  that a `decoims.com` `src=` there makes the CDN fetch itself (508). On the
  Azion hosts (`deco-assets.edgedeco.com`, `deco-assets.decoazn.com`) the full
  `decoims.com` URL is kept, since they fetch it fine.
- **Numbers are ignored.** `quality: 90` on a call falls back to the
  `quality` option. Only the four tier names reach the CDN.
- `hosts` is `[domain]`.

## Platform providers

These live in the platform's client package, not in `@decocms/blocks`. List them
before `decoCdn`.

### VTEX: `@decocms/apps-vtex/image`

Each reproduces one URL format sites already use, byte for byte. Pick the one
the site's old helper matched; changing format changes every image URL and
empties the CDN cache.

| Provider | Matches | Output |
|---|---|---|
| `vtexCatalog()` | `*.vteximg.com.br`, `*.vtexassets.com`, `*.myvtex.com` URLs with `/arquivos/ids/{id}` | `/arquivos/ids/{id}-{width}-{height ?? width}/…` (v7's `Image`). Ignores quality. |
| `vtexCatalogFrame({ frame? })` | Any host with `/arquivos/ids/{id}[-w-h]/` | `{id}-{w}-{h}`. With `frame: { width, height }`, height is always `round(width × frame.height / frame.width)`; VTEX fills the rest with white. |
| `vtexCatalogWebp({ quality? })` | Any URL with `/ids/{id}` and a file extension | `/ids/{id}-{width}-auto/{file}.webp?…&quality=` (VTEX keeps the ratio). Without an extension it returns null. |
| `vtexFileManager({ via, quality? })` | URLs containing `vtexassets` and `/assets` (file-manager images) | `via: "query"`: `?width=&aspect=true&quality=`. `via: "thumbor"`: PNG/JPEG/WebP through `/unsafe/{w}x0/filters:…:format(webp)/…`; SVG and GIF unchanged. |

VTEX quality is on a 1 to 10 scale. Tiers map to 60/70/80/100 and then to
6/7/8/10; numbers above 10 are read as 1 to 100, divided by 10 and rounded up. Default 8.

```ts
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { vtexCatalog, vtexFileManager } from "@decocms/apps-vtex/image";

export const imageUrl = createImageUrl({
  providers: [
    vtexCatalog(),
    vtexFileManager({ via: "query" }),
    decoCdn({ sources: "all", quality: "high" }),
  ],
});
```

### Shopify: `@decocms/apps-shopify/image`

`shopifyCdn()` matches `https://cdn.shopify.com…` and sets `width`, `height`
(when given) and `crop=center` on the query. It ignores `quality` and `fit`.

### Other platforms

No other `@decocms/apps-*` package ships an image provider. If a platform's CDN
resizes by URL, write a provider in the site:

```ts
import type { ImageProvider } from "@decocms/blocks/image";

export const platformCdn: ImageProvider = {
  name: "platform",
  hosts: ["images.platform.example"],
  match: (src) => src.startsWith("https://images.platform.example/"),
  format(src, { width, height }) {
    const url = new URL(src);
    url.searchParams.set("w", String(width));
    if (height) url.searchParams.set("h", String(height));
    return url.href;
  },
};
```

Return `null` from `format` for a source you matched but cannot resize, so the
next provider gets it. Without a provider, `decoCdn({ sources: "all" })` sends
those images through the Deco CDN instead, which also works.

## `hosts()` for CSP and preconnect

`imageUrl.hosts()` lists every provider's hosts once, wildcards included (the
VTEX providers report `*.vtexassets.com` and similar). No binding reads it for
you. If the site sets a Content-Security-Policy, add these hosts to `img-src`;
the CSP itself is set up as described in `deco-tanstack-site` or
`deco-nextjs-site`. A source that passes through unchanged loads from its own
host, which `hosts()` does not list.

## Which `decoCdn` setup to start from

| Site | Providers |
|---|---|
| Content site, images uploaded to Deco | `[decoCdn({ quality: "high" })]` |
| Images from many hosts, all through the Deco CDN | `[decoCdn({ sources: "all", quality: "high" })]` (this is what TanStack's default does, without the tier) |
| VTEX storefront | `[vtexCatalog(), decoCdn({ sources: "all", quality: "high" })]` |
| Shopify storefront | `[shopifyCdn(), decoCdn({ sources: "all", quality: "high" })]` |
| Migrated v7 site | Match the old domain, quality and layout exactly, so URLs do not change. `deco-v7-to-v8-migration` reads these from the site's old helper. |

`"high"` above is a starting point, not a package default. See
[quality-and-lcp.md](./quality-and-lcp.md).
