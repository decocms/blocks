/**
 * `@decocms/blocks/image`: image URLs for the Deco image CDN, srcset and
 * preload data.
 *
 * Pure functions: no React, no framework, no module state. A site builds one
 * `ImageUrl` from the providers its images come from and passes it to the
 * binding's components or image loader. v7's `registerImageCdnDomain` and
 * `registerImageQuality` do not come back: they were module-wide state, the
 * dual-instance hazard the package split removed; their values are
 * `decoCdn`'s `domain` and `quality` options.
 *
 * Only the Deco CDN lives here. A commerce platform's own resize syntax is a
 * provider in that platform's client package (`@decocms/apps-vtex/image`,
 * `@decocms/apps-shopify/image`), listed before `decoCdn`.
 */

export type Fit = "contain" | "cover" | "fill";

/**
 * A named tier ("low" | "medium" | "high" | "original", what the Deco image CDN
 * accepts) or a number. The Deco CDN ignores numbers; a provider for another
 * service says how it reads them.
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

export interface ImageProvider {
  name: string;
  /** Whether this provider handles `src` (what `ImageUrl.isOptimizable` reports). */
  match(src: string): boolean;
  /** The resized URL, or null to leave `src` to the next provider. */
  format(src: string, o: ResizeOptions): string | null;
  /** Hosts the formatted URLs point at, for CSP img-src and preconnect. */
  hosts?: string[];
}

export interface ImageUrl {
  /** The resized URL; "" for an empty src, data: URIs and unknown sources unchanged. */
  (src: string, o: ResizeOptions): string;
  /** Whether a provider handles `src` (false for "", data: URIs and unknown sources). */
  isOptimizable(src: string): boolean;
  hosts(): string[];
}

// ---------------------------------------------------------------------------
// Deco image CDN
// ---------------------------------------------------------------------------

const DECO_CACHE_URL = "https://assets.decocache.com/";
const DECO_S3_URL = "https://deco-sites-assets.s3.sa-east-1.amazonaws.com/";
const LEADING_ASSET_HOST =
  /^https:\/\/(?:assets\.decocache\.com|deco-sites-assets\.s3\.sa-east-1\.amazonaws\.com)\//;
/** Deco CDNs on Cloudflare: a decoims.com src= makes them fetch themselves (508), so it is stripped. */
const CLOUDFLARE_DECO_CDNS = new Set(["assets.decocms.com", "decoims.com"]);
/** Every host that serves the Deco image CDN's `/image?…&src=` endpoint. */
const DECO_IMAGE_HOSTS = [
  "assets.decocms.com",
  "decoims.com",
  "deco-assets.edgedeco.com",
  "deco-assets.decoazn.com",
];
/** Characters an unwrapped `src` cannot carry raw in the query this provider writes. */
const QUERY_UNSAFE = /[%&#+]/g;

export interface DecoCdnOptions {
  /** The CDN host. Default "assets.decocms.com"; "decoims.com", "deco-assets.edgedeco.com" also serve it. */
  domain?: string;
  /** Tier asked for when a call names none (a call's numeric quality is ignored). Default: none, the CDN's 60%. */
  quality?: QualityTier;
  /** Fit when a call names none. Default "cover", as v7's `getSrcSet` and `Image`. */
  fit?: Fit;
  /**
   * Earlier CDN hosts whose URLs are re-served from `domain`. Default ["decoims.com"]
   * on the Cloudflare CDNs, [] otherwise (the Azion CDNs fetch decoims.com URLs fine).
   */
  legacyHosts?: string[];
  /**
   * The sources this provider resizes. "deco" (default): the Deco asset hosts,
   * `domain` and `legacyHosts`; others pass through. "all": every non-empty,
   * non-data: source, v7's behaviour (put the provider last). Or a predicate.
   */
  sources?: "deco" | "all" | ((src: string) => boolean);
  /**
   * How the Deco asset hosts (assets.decocache.com, the S3 bucket) are removed
   * from the source. "anywhere" (default, v7's `getOptimizedMediaUrl`): the
   * first occurrence of each, wherever it is. "leading": only a host the
   * source starts with.
   */
  stripAssetHosts?: "anywhere" | "leading";
  /**
   * Query layout. "src-last" (default, v7's `getOptimizedMediaUrl`):
   * `?fit=&width=[&height=][&quality=]&src=<raw path>`. "quality-last" (what
   * next/image loaders built on v7's helper emit): the same URL re-serialised,
   * `?fit=&width=[&height=]&src=<form-encoded path>&quality=`. Both are served
   * the same way; keep the one a site uses so the CDN cache stays warm.
   */
  layout?: "src-last" | "quality-last";
}

function stripScheme(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * The `src` an already-resized Deco CDN URL (`https://<cdn>/image?…&src=…`)
 * was made from, as the CDN reads it (query-decoded); null for any other URL.
 */
function decoImageSource(src: string, hosts: Set<string>): string | null {
  if (!/^https?:\/\//i.test(src) || !/\/image\?/i.test(src)) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (!hosts.has(url.hostname) || url.pathname !== "/image") return null;
  const inner = url.searchParams.get("src");
  return inner ? inner : null;
}

/**
 * The Deco image CDN (`https://<domain>/image?fit=&width=…&src=`). An
 * already-resized Deco CDN URL (any of its hosts' `/image?…&src=`) that this
 * provider resizes (see `sources`) is re-resized from its `src`; before, it
 * became `src=image` or `src=<cdn>/image`, which the CDN cannot serve.
 */
export function decoCdn(o: DecoCdnOptions = {}): ImageProvider {
  const domain = stripScheme(o.domain ?? "assets.decocms.com");
  const legacy = (o.legacyHosts ?? (CLOUDFLARE_DECO_CDNS.has(domain) ? ["decoims.com"] : []))
    .map(stripScheme)
    .filter((h) => h !== domain);
  const decoPrefixes = [
    `https://${domain}/`,
    ...legacy.map((h) => `https://${h}/`),
    DECO_CACHE_URL,
    DECO_S3_URL,
  ];
  const sources = o.sources ?? "deco";
  const layout = o.layout ?? "src-last";
  const imageHosts = new Set([...DECO_IMAGE_HOSTS, domain, ...legacy]);

  return {
    name: "deco",
    hosts: [domain],
    match(src) {
      if (typeof sources === "function") return sources(src);
      if (sources === "all") return src.length > 0 && !src.startsWith("data:");
      // Only the sources resized before fix 2: a Deco CDN URL this provider
      // did not match (another CDN host, http, an uppercase host) still passes
      // through unchanged, as it was served fine.
      return decoPrefixes.some((p) => src.startsWith(p));
    },
    format(src, r) {
      // An already-resized Deco CDN URL is re-resized from the src it was made
      // from (nested ones too); before, `src=` got the CDN URL's own path
      // ("image") and the CDN answered 404.
      let unwrapped = false;
      for (let inner = decoImageSource(src, imageHosts), i = 0; inner !== null && i < 8; i++) {
        src = inner;
        unwrapped = true;
        inner = decoImageSource(src, imageHosts);
      }
      let source =
        o.stripAssetHosts === "leading"
          ? src.replace(LEADING_ASSET_HOST, "")
          : src.replace(DECO_CACHE_URL, "").replace(DECO_S3_URL, "");
      source = source.split("?")[0];
      for (const host of [...legacy, domain]) {
        if (source.startsWith(`https://${host}/`)) source = source.slice(host.length + 9);
      }
      if (unwrapped) source = source.replace(QUERY_UNSAFE, encodeURIComponent);
      const quality = typeof r.quality === "string" ? r.quality : o.quality;
      const params = new URLSearchParams();
      params.set("fit", r.fit ?? o.fit ?? "cover");
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
// ImageUrl, srcset, preload
// ---------------------------------------------------------------------------

/**
 * One URL builder for a site. Providers are tried in order: the first that
 * matches `src` and returns a URL wins; unknown sources pass through unchanged.
 */
export function createImageUrl(o: { providers: ImageProvider[] }): ImageUrl {
  const providers = [...o.providers];
  const usable = (src: string) =>
    typeof src === "string" && src.length > 0 && !src.startsWith("data:");
  const url = ((src: string, r: ResizeOptions) => {
    if (typeof src !== "string" || src.length === 0) return "";
    if (!usable(src)) return src;
    for (const p of providers) {
      if (!p.match(src)) continue;
      const out = p.format(src, r);
      if (out !== null) return out;
    }
    return src;
  }) as ImageUrl;
  url.isOptimizable = (src) => usable(src) && providers.some((p) => p.match(src));
  url.hosts = () => [...new Set(providers.flatMap((p) => p.hosts ?? []))];
  return url;
}

export interface SrcSetOptions {
  /**
   * Base width for `factors`. Left out, each candidate is `NaN` wide, as v7's
   * `getSrcSet` wrote it for an `Image` or `Source` without a width.
   */
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

/** `"<url> <w>w, ..."`, or undefined for an empty src or no candidates (`widths: []`). */
export function srcSet(url: ImageUrl, src: string, o: SrcSetOptions): string | undefined {
  if (typeof src !== "string" || src.length === 0) return undefined;
  const sizes: { w: number; h?: number }[] = o.widths
    ? o.widths.map((w) => ({ w, h: o.ratio ? Math.round(w * o.ratio) : undefined }))
    : // No width: v7's NaN candidates (`width=NaN … NaNw`), kept byte for byte.
      (o.factors ?? [1, 2]).map((f) => {
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
