/**
 * `@decocms/blocks/image`: image URL format and parse, srcset and preload data.
 *
 * Pure functions: no React, no framework, no module state. A site builds one
 * `ImageUrl` from the providers its images come from and passes it to the
 * binding's components (`@decocms/tanstack/react`) or to a next/image loader
 * (`@decocms/nextjs/image-loader`). v7's `registerImageCdnDomain` and
 * `registerImageQuality` do not come back: they were module-wide state, the
 * dual-instance hazard the package split removed.
 *
 * Every provider recognises the URLs it produced (`parse`), so formatting an
 * already-resized URL resizes the original instead of nesting a resize inside
 * another: `format(format(x, o), o) === format(x, o)`.
 */

export type Fit = "contain" | "cover" | "fill";

/**
 * A named tier ("low" | "medium" | "high" | "original", what the Deco image CDN
 * accepts) or a number. The Deco CDN ignores numbers (it answers 200 with its
 * default for anything but a tier); the VTEX providers read numbers on next/image's
 * 1-100 scale or VTEX's own 1-10 scale, and tiers as 60/70/80/100.
 */
export type Quality = "low" | "medium" | "high" | "original" | number;

/** The Deco image CDN's quality tiers. */
export type QualityTier = "low" | "medium" | "high" | "original";

export interface ResizeOptions {
  width: number;
  height?: number;
  fit?: Fit;
  quality?: Quality;
}

export interface ParsedImage {
  /** The provider that produced the URL. */
  provider: string;
  /** The source URL before resizing. */
  original: string;
  width?: number;
  height?: number;
}

export interface ImageProvider {
  name: string;
  /** Whether this provider resizes `src` (an original or one of its own resized URLs). */
  match(src: string): boolean;
  format(src: string, o: ResizeOptions): string;
  /** Recognises a URL this provider produced; null for anything else. */
  parse(src: string): ParsedImage | null;
  /** Hosts the formatted URLs point at, for CSP img-src and preconnect. */
  hosts?: string[];
}

export interface ImageUrl {
  /** The resized URL; "" for an empty src, data: URIs and unknown sources unchanged. */
  (src: string, o: ResizeOptions): string;
  /** Whether a provider resizes `src` (false for "", data: URIs and unknown sources). */
  isOptimizable(src: string): boolean;
  parse(src: string): ParsedImage | null;
  hosts(): string[];
}

// ---------------------------------------------------------------------------
// Deco image CDN
// ---------------------------------------------------------------------------

const DECO_ASSET_PREFIXES = [
  "https://assets.decocache.com/",
  "https://deco-sites-assets.s3.sa-east-1.amazonaws.com/",
];
/** Deco CDNs on Cloudflare: a decoims.com src= makes them fetch themselves (508), so it is stripped. */
const CLOUDFLARE_DECO_CDNS = new Set(["assets.decocms.com", "decoims.com"]);

export interface DecoCdnOptions {
  /** The CDN host. Default "assets.decocms.com"; "decoims.com", "deco-assets.edgedeco.com" also serve it. */
  domain?: string;
  /** Tier asked for when a call names none (a call's numeric quality is ignored). Default: none, the CDN's 60%. */
  quality?: QualityTier;
  /**
   * Earlier CDN hosts whose URLs are re-served from `domain`. Default ["decoims.com"]
   * on the Cloudflare CDNs, [] otherwise (the Azion CDNs fetch decoims.com URLs fine).
   */
  legacyHosts?: string[];
  /**
   * Also proxy sources the CDN does not host (any https URL or path): v7's
   * behaviour, where every image but VTEX and Shopify went through the CDN.
   * Put the provider last when this is on. Default false: those pass through.
   */
  proxyOtherHosts?: boolean;
  /**
   * Query layout. "src-last" (default, v7's `getOptimizedMediaUrl`):
   * `?fit=&width=[&height=][&quality=]&src=<raw path>`. "quality-last" (what
   * next/image loaders built on v7's helper emit): the same URL re-serialised,
   * `?fit=&width=[&height=]&src=<form-encoded path>&quality=`. Both are served
   * the same way; keep the one a site uses so the CDN cache stays warm.
   */
  layout?: "src-last" | "quality-last";
}

function stripTrailing(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function decoCdn(o: DecoCdnOptions = {}): ImageProvider {
  const domain = stripTrailing(o.domain ?? "assets.decocms.com");
  const legacy = (o.legacyHosts ?? (CLOUDFLARE_DECO_CDNS.has(domain) ? ["decoims.com"] : [])).map(
    stripTrailing,
  );
  const cdnHosts = [domain, ...legacy.filter((h) => h !== domain)];
  const prefixes = [...DECO_ASSET_PREFIXES, ...cdnHosts.map((h) => `https://${h}/`)];
  const layout = o.layout ?? "src-last";

  const isResized = (src: string) => cdnHosts.some((h) => src.startsWith(`https://${h}/image?`));

  const parse = (src: string): ParsedImage | null => {
    if (!isResized(src)) return null;
    const query = src.slice(src.indexOf("?") + 1);
    // src-last keeps the path raw as the last param; quality-last form-encodes it.
    const raw = /(?:^|&)src=(.*)$/.exec(query)?.[1];
    const params = new URLSearchParams(query);
    const source = raw && !raw.includes("&") && !/%2F/i.test(raw) ? raw : params.get("src");
    if (!source) return null;
    const original =
      /^https?:\/\//.test(source) || source.startsWith("/")
        ? source
        : `https://${domain}/${source}`;
    const width = Number(params.get("width")) || undefined;
    const height = Number(params.get("height")) || undefined;
    return { provider: "deco", original, width, height };
  };

  const isDecoHosted = (src: string) => prefixes.some((p) => src.startsWith(p));

  return {
    name: "deco",
    hosts: [domain],
    match(src) {
      if (o.proxyOtherHosts) return src.length > 0 && !src.startsWith("data:");
      return isDecoHosted(src);
    },
    parse,
    format(src, r) {
      const source0 = parse(src)?.original ?? src;
      let source = source0.split("?")[0];
      for (const prefix of prefixes) {
        if (source.startsWith(prefix)) {
          source = source.slice(prefix.length);
          break;
        }
      }
      const fit = r.fit ?? (r.height ? "cover" : "contain");
      const quality = typeof r.quality === "string" ? r.quality : o.quality;
      const params = new URLSearchParams();
      params.set("fit", fit);
      params.set("width", `${r.width}`);
      if (r.height) params.set("height", `${r.height}`);
      if (layout === "src-last") {
        if (quality) params.set("quality", quality);
        return `https://${domain}/image?${params}&src=${source}`;
      }
      const url = new URL(`https://${domain}/image?${params}&src=${source}`);
      if (quality) url.searchParams.set("quality", quality);
      return url.toString();
    },
  };
}

// ---------------------------------------------------------------------------
// VTEX
// ---------------------------------------------------------------------------

const VTEX_HOST = /^https?:\/\/[^/?#]*(?:vteximg\.com\.br|vtexassets\.com|myvtex\.com)\//;
/** `/arquivos/ids/{id}[-{suffix}]/`, the suffix being a size VTEX baked in (`-500-500`, `-768-auto`). */
const VTEX_IDS = /\/arquivos\/ids\/(\d+)(?:-([^/?#]*))?\//;
const QUALITY_TIERS = { low: 60, medium: 70, high: 80, original: 100 } as const;

/** VTEX's 1-10 quality scale: tiers as 60/70/80/100, numbers above 10 read as 1-100. */
function vtexQuality(q: Quality): number {
  const n = typeof q === "string" ? QUALITY_TIERS[q] : q;
  return n > 10 ? Math.ceil(Math.min(n, 100) / 10) : n;
}

export interface VtexCatalogOptions {
  /**
   * The resized box. "exact": `{id}-{width}-{height ?? width}`. "auto":
   * `{id}-{width}-auto` (VTEX keeps the photo's ratio). `{ ratio }`:
   * `{id}-{width}-{round(width * ratio)}`, a fixed frame (ratio = height / width).
   */
  size: "exact" | "auto" | { ratio: number };
  /** Ask VTEX to convert: the file extension becomes `.webp`. */
  format?: "webp";
  /** `?quality=` (1-10) when a call names none. Default: none. */
  quality?: Quality;
  /**
   * Match `/arquivos/ids/` on any host (a store domain serving the catalog).
   * Default false: only `*.vteximg.com.br`, `*.vtexassets.com` and `*.myvtex.com`.
   */
  anyHost?: boolean;
}

/** VTEX catalog (product) images: `/arquivos/ids/{id}/{file}`. */
export function vtexCatalog(o: VtexCatalogOptions): ImageProvider {
  const matches = (src: string) => VTEX_IDS.test(src) && (o.anyHost || VTEX_HOST.test(src));
  return {
    name: "vtex",
    hosts: ["*.vtexassets.com", "*.vteximg.com.br", "*.myvtex.com"],
    match: matches,
    parse(src) {
      if (!matches(src)) return null;
      const m = VTEX_IDS.exec(src) as RegExpExecArray;
      const size = /^(\d+)-(\d+|auto)$/.exec(m[2] ?? "");
      if (!size) return null;
      return {
        provider: "vtex",
        original: src.replace(m[0], `/arquivos/ids/${m[1]}/`),
        width: Number(size[1]),
        height: size[2] === "auto" ? undefined : Number(size[2]),
      };
    },
    format(src, r) {
      const m = VTEX_IDS.exec(src);
      if (!m) return src;
      const width = Math.round(r.width);
      const height =
        o.size === "auto"
          ? "auto"
          : o.size === "exact"
            ? Math.round(r.height ?? r.width)
            : Math.round(width * o.size.ratio);
      const head = src.slice(0, m.index);
      let rest = src.slice(m.index + m[0].length);
      const quality = r.quality ?? o.quality;
      if (o.format || quality !== undefined) {
        const q = rest.search(/[?#]/);
        let file = q === -1 ? rest : rest.slice(0, q);
        const query = q === -1 ? "" : rest.slice(q);
        if (o.format) file = file.replace(/(\.[^/.]+)?$/, `.${o.format}`);
        if (quality === undefined) rest = file + query;
        else {
          const params = new URLSearchParams(query);
          params.set("quality", `${vtexQuality(quality)}`);
          rest = `${file}?${params}`;
        }
      }
      return `${head}/arquivos/ids/${m[1]}-${width}-${height}/${rest}`;
    },
  };
}

const RASTER = /\.(png|jpe?g|webp)$/i;
const ANIMATED_OR_VECTOR = /\.(svg|gif)$/i;
const THUMBOR = /^(https:\/\/[^/?#]*vtexassets\.com)\/unsafe\/(\d+)x0\/[^/]*\/([^/?#]+)$/;

export interface VtexFileManagerOptions {
  /**
   * "thumbor" (recommended): PNG/JPEG/WebP go through VTEX's Thumbor route
   * (`/unsafe/{w}x0/filters:no_upscale():quality():format(webp)/{url}`), SVG and
   * GIF go out raw, anything else uses the query resizer. "query": the
   * `?width=&aspect=true&quality=` resizer for everything (it has answered 500
   * for raster files since 2026-10-07).
   */
  via: "thumbor" | "query";
  /** 1-10 when a call names none. Default 8. */
  quality?: Quality;
}

/** VTEX file-manager (CMS) images: `*.vtexassets.com/assets/...`. */
export function vtexFileManager(o: VtexFileManagerOptions): ImageProvider {
  const isAsset = (src: string) => /^https?:\/\/[^/?#]*vtexassets\.com\/assets\//.test(src);
  const parse = (src: string): ParsedImage | null => {
    const m = THUMBOR.exec(src);
    if (!m) return null;
    const original = decodeURIComponent(m[3]);
    if (!isAsset(original)) return null;
    return { provider: "vtex-file-manager", original, width: Number(m[2]) };
  };
  return {
    name: "vtex-file-manager",
    hosts: ["*.vtexassets.com"],
    match: (src) => isAsset(src) || parse(src) !== null,
    parse,
    format(src, r) {
      const url = new URL(parse(src)?.original ?? src);
      const width = Math.round(r.width);
      const quality = vtexQuality(r.quality ?? o.quality ?? 8);
      if (o.via === "thumbor") {
        if (RASTER.test(url.pathname)) {
          url.search = "";
          return `${url.origin}/unsafe/${width}x0/filters:no_upscale():quality(${Math.min(quality, 8) * 10}):format(webp)/${encodeURIComponent(url.toString())}`;
        }
        if (ANIMATED_OR_VECTOR.test(url.pathname)) return src;
      }
      url.searchParams.set("width", `${width}`);
      url.searchParams.set("aspect", "true");
      url.searchParams.set("quality", `${quality}`);
      return url.toString();
    },
  };
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

export function shopify(): ImageProvider {
  const match = (src: string) => src.startsWith("https://cdn.shopify.com");
  return {
    name: "shopify",
    hosts: ["cdn.shopify.com"],
    match,
    parse(src) {
      if (!match(src)) return null;
      const url = new URL(src);
      if (url.searchParams.get("crop") !== "center" || !url.searchParams.has("width")) return null;
      const width = Number(url.searchParams.get("width")) || undefined;
      const height = Number(url.searchParams.get("height")) || undefined;
      for (const k of ["width", "height", "crop"]) url.searchParams.delete(k);
      return { provider: "shopify", original: url.href, width, height };
    },
    format(src, r) {
      const url = new URL(src);
      url.searchParams.set("width", `${r.width}`);
      if (r.height) url.searchParams.set("height", `${r.height}`);
      else url.searchParams.delete("height");
      url.searchParams.set("crop", "center");
      return url.href;
    },
  };
}

// ---------------------------------------------------------------------------
// ImageUrl, srcset, preload
// ---------------------------------------------------------------------------

/** One URL builder for a site. Providers are tried in order; unknown sources pass through unchanged. */
export function createImageUrl(o: { providers: ImageProvider[] }): ImageUrl {
  const providers = [...o.providers];
  const find = (src: string) =>
    typeof src === "string" && src.length > 0 && !src.startsWith("data:")
      ? providers.find((p) => p.match(src))
      : undefined;
  const url = ((src: string, r: ResizeOptions) => {
    if (typeof src !== "string" || src.length === 0) return "";
    const provider = find(src);
    return provider ? provider.format(src, r) : src;
  }) as ImageUrl;
  url.isOptimizable = (src) => find(src) !== undefined;
  url.parse = (src) => {
    if (typeof src !== "string") return null;
    for (const p of providers) {
      const parsed = p.parse(src);
      if (parsed) return parsed;
    }
    return null;
  };
  url.hosts = () => [...new Set(providers.flatMap((p) => p.hosts ?? []))];
  return url;
}

export interface SrcSetOptions {
  /** Base width for `factors`. */
  width?: number;
  /** Candidate widths; when given, `width` and `factors` are not used. */
  widths?: number[];
  /** Multipliers of `width` (truncated, as v7 did). Default [1, 2]. */
  factors?: number[];
  /** Base height for `factors`, scaled with the width. */
  height?: number;
  /** height / width, for a fixed frame: each candidate gets round(w * ratio). */
  ratio?: number;
  fit?: Fit;
  quality?: Quality;
}

/** `"<url> <w>w, ..."`, or undefined for an empty src or no candidates. */
export function srcSet(url: ImageUrl, src: string, o: SrcSetOptions): string | undefined {
  if (typeof src !== "string" || src.length === 0) return undefined;
  const sizes: { w: number; h?: number }[] = o.widths
    ? o.widths.map((w) => ({ w, h: o.ratio ? Math.round(w * o.ratio) : undefined }))
    : o.width === undefined
      ? []
      : (o.factors ?? [1, 2]).map((f) => {
          const w = Math.trunc(f * (o.width as number));
          const h = o.height
            ? Math.trunc(f * o.height)
            : o.ratio
              ? Math.round(w * o.ratio)
              : undefined;
          return { w, h };
        });
  const entries: string[] = [];
  for (const { w, h } of sizes) {
    const href = url(src, { width: w, height: h, fit: o.fit, quality: o.quality });
    if (href) entries.push(`${href} ${w}w`);
  }
  return entries.length > 0 ? entries.join(", ") : undefined;
}

/** Candidates of a srcset attribute (URLs with commas inside are kept whole). */
export function parseSrcSet(s: string): { url: string; w?: number; x?: number }[] {
  const out: { url: string; w?: number; x?: number }[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    i = j;
    let descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      while (i < s.length && s[i] !== ",") descriptor += s[i++];
      i++;
    }
    const entry: { url: string; w?: number; x?: number } = { url };
    const d = /^(\d+(?:\.\d+)?)([wx])$/.exec(descriptor.trim());
    if (d) entry[d[2] as "w" | "x"] = Number(d[1]);
    out.push(entry);
  }
  return out;
}

export interface PreloadOptions extends SrcSetOptions {
  width: number;
  sizes?: string;
  media?: string;
  /** Default "high". */
  fetchPriority?: "high" | "low" | "auto";
}

export interface PreloadLink {
  rel: "preload";
  as: "image";
  href: string;
  imageSrcSet?: string;
  imageSizes?: string;
  media?: string;
  fetchPriority?: string;
}

/** The attributes of a `<link rel="preload" as="image">` for an LCP image. */
export function preloadLink(url: ImageUrl, src: string, o: PreloadOptions): PreloadLink {
  const link: PreloadLink = {
    rel: "preload",
    as: "image",
    href: url(src, { width: o.width, height: o.height, fit: o.fit, quality: o.quality }),
  };
  const set = srcSet(url, src, o);
  if (set) {
    link.imageSrcSet = set;
    if (o.sizes) link.imageSizes = o.sizes;
  }
  if (o.media) link.media = o.media;
  link.fetchPriority = o.fetchPriority ?? "high";
  return link;
}
