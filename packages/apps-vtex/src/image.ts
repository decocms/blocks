/**
 * `@decocms/apps-vtex/image`: VTEX's image URLs as `ImageProvider`s for
 * `createImageUrl` (`@decocms/blocks/image`). Pure functions: no fetch, no
 * React, no module state. List them before `decoCdn`:
 *
 * ```ts
 * import { createImageUrl, decoCdn } from "@decocms/blocks/image";
 * import { vtexCatalog } from "@decocms/apps-vtex/image";
 * export const imageUrl = createImageUrl({ providers: [vtexCatalog(), decoCdn({ sources: "all" })] });
 * ```
 *
 * Each provider reproduces one URL format sites use today, byte for byte
 * (the golden cases in `__fixtures__/image-golden.jsonl`): pick the one your
 * site's helper matches.
 */
import type { ImageProvider, Quality } from "@decocms/blocks/image";

const VTEX_HOSTS = ["*.vtexassets.com", "*.vteximg.com.br", "*.myvtex.com"];
const TIERS = { low: 60, medium: 70, high: 80, original: 100 } as const;

/** VTEX's 1-10 quality scale: tiers as 60/70/80/100, numbers above 10 read as 1-100. */
function vtexQuality(q: Quality): number {
  const n = typeof q === "string" ? TIERS[q] : q;
  return n > 10 ? Math.ceil(Math.min(n, 100) / 10) : n;
}

/**
 * Catalog (product) images on VTEX's hosts, as v7's `Image` resized them:
 * `/arquivos/ids/{id}[-…]/` becomes `{id}-{width}-{height ?? width}`, and the
 * URL comes back re-serialised by `URL` (so unencoded characters are
 * percent-encoded). Sources: `*.vteximg.com.br`, `*.vtexassets.com` and
 * `*.myvtex.com` URLs with `/arquivos/ids/{id}`.
 */
export function vtexCatalog(): ImageProvider {
  return {
    name: "vtex",
    hosts: VTEX_HOSTS,
    match: (src) => /(vteximg\.com\.br|vtexassets\.com|myvtex\.com)\/arquivos\/ids\/\d+/.test(src),
    format(src, r) {
      const url = new URL(src);
      const [slash, arquivos, ids, rawId, ...rest] = url.pathname.split("/");
      const [id] = rawId.split("-");
      url.pathname = [
        slash,
        arquivos,
        ids,
        `${id}-${r.width}-${r.height ?? r.width}`,
        ...rest,
      ].join("/");
      return url.href;
    },
  };
}

const FRAME_PATH = /\/arquivos\/ids\/(\d+)(?:-\d+-(?:\d+|auto))?\//;

export interface VtexCatalogFrameOptions {
  /**
   * A fixed frame: every image gets `round(width * frame.height / frame.width)`
   * as its height, whatever the call asks (VTEX fits the photo and fills the
   * rest with white). Without it, the call's `height ?? width`.
   */
  frame?: { width: number; height: number };
}

/**
 * Catalog images on any host (a store domain serving the catalog too):
 * `/arquivos/ids/{id}[-{w}-{h|auto}]/` becomes `{id}-{round(w)}-{round(h)}`,
 * the rest of the URL untouched. Other sources pass to the next provider.
 */
export function vtexCatalogFrame(o: VtexCatalogFrameOptions = {}): ImageProvider {
  return {
    name: "vtex-frame",
    hosts: VTEX_HOSTS,
    match: (src) => FRAME_PATH.test(src),
    format(src, r) {
      const m = src.match(FRAME_PATH);
      if (!m) return null;
      const height = o.frame ? (r.width * o.frame.height) / o.frame.width : (r.height ?? r.width);
      return src.replace(
        m[0],
        `/arquivos/ids/${m[1]}-${Math.round(r.width)}-${Math.round(height)}/`,
      );
    },
  };
}

const WEBP_PATH = /(\/ids\/\d+)(?:-[^/?]+)?\/([^/?]+)(\.[^/?]+)(\?.+)?$/;

export interface VtexCatalogWebpOptions {
  /** Quality when a call names none, on VTEX's 1-10 scale (1-100 and tiers are converted). Default 8. */
  quality?: Quality;
}

/**
 * Catalog images on any host, converted to WebP, as next/image loaders on
 * VTEX stores build them: `/ids/{id}[-…]/{file}.{ext}[?query]` becomes
 * `/ids/{id}-{width}-auto/{file}.webp?{query}&quality={1-10}` (VTEX keeps the
 * photo's ratio). It handles any URL containing `/ids/{id}`; one without a
 * file extension passes to the next provider.
 */
export function vtexCatalogWebp(o: VtexCatalogWebpOptions = {}): ImageProvider {
  return {
    name: "vtex-webp",
    hosts: VTEX_HOSTS,
    match: (src) => /\/ids\/\d+/.test(src),
    format(src, r) {
      if (!WEBP_PATH.test(src)) return null;
      const quality = `${vtexQuality(r.quality ?? o.quality ?? 8)}`;
      return src.replace(WEBP_PATH, (_m, id: string, file: string, _ext, query = "") => {
        const params = new URLSearchParams(query);
        params.set("quality", quality);
        return `${id}-${r.width}-auto/${file}.webp?${params.toString()}`;
      });
    },
  };
}

export interface VtexFileManagerOptions {
  /**
   * "query": VTEX's `?width=&aspect=true&quality=` resizer for every file.
   * "thumbor": PNG, JPEG and WebP go through VTEX's Thumbor route
   * (`/unsafe/{w}x0/filters:no_upscale():quality({q*10, at most 80}):format(webp)/{url}`),
   * SVG and GIF go out unchanged, anything else uses the query resizer.
   */
  via: "query" | "thumbor";
  /** Quality when a call names none, on VTEX's 1-10 scale. Default 8. */
  quality?: Quality;
}

/**
 * File-manager (CMS) images: any URL containing `vtexassets` and `/assets`
 * (`*.vtexassets.com/assets/vtex.file-manager-graphql/...`).
 */
export function vtexFileManager(o: VtexFileManagerOptions): ImageProvider {
  return {
    name: "vtex-file-manager",
    hosts: ["*.vtexassets.com"],
    match: (src) => src.includes("vtexassets") && src.includes("/assets"),
    format(src, r) {
      const quality = vtexQuality(r.quality ?? o.quality ?? 8);
      const url = new URL(src);
      if (o.via === "thumbor") {
        if (/\.(png|jpe?g|webp)$/i.test(url.pathname)) {
          url.search = "";
          return `${url.origin}/unsafe/${r.width}x0/filters:no_upscale():quality(${Math.min(quality, 8) * 10}):format(webp)/${encodeURIComponent(url.toString())}`;
        }
        if (/\.(svg|gif)$/i.test(url.pathname)) return src;
      }
      url.searchParams.set("width", r.width.toString());
      url.searchParams.set("aspect", "true");
      url.searchParams.set("quality", quality.toString());
      return url.toString();
    },
  };
}
