/**
 * `@decocms/nextjs/image-loader`: a next/image loader over an `ImageUrl` from
 * `@decocms/blocks/image`. The site's `loaderFile` is one line:
 *
 * ```ts
 * // src/image-loader.ts (next.config: images: { loader: "custom", loaderFile: "./src/image-loader.ts" })
 * import { createDecoImageLoader } from "@decocms/nextjs/image-loader";
 * import { imageUrl } from "./imageUrl";
 * export default createDecoImageLoader(imageUrl);
 * ```
 *
 * A source the `ImageUrl` resizes gets its provider's URL; any other source
 * goes to `fallback` (`nextImageOptimizer` sends it through Next's own
 * `/_next/image`), or comes back unchanged. No React, no module state.
 */
import type { ImageUrl, Quality } from "@decocms/blocks/image";

/** What next/image passes a loader (`ImageLoaderProps`), with Deco's named tiers allowed as quality. */
export interface DecoImageLoaderProps {
  src: string;
  width: number;
  quality?: Quality;
}

export type DecoImageLoader = (props: DecoImageLoaderProps) => string;

export interface DecoImageLoaderOptions {
  /** The URL of a source no provider resizes; `null` keeps `src`. Default: `src` unchanged. */
  fallback?: (props: DecoImageLoaderProps) => string | null;
}

const TIER_VALUES = { low: 60, medium: 70, high: 80, original: 100 } as const;

/**
 * Next's built-in optimizer (`/_next/image?url=&w=&q=`), for sources no
 * provider resizes: a local `/public` file, another host listed in
 * `images.remotePatterns`.
 */
export function nextImageOptimizer({ src, width, quality }: DecoImageLoaderProps): string {
  const params = new URLSearchParams();
  params.set("url", src);
  params.set("w", width.toString());
  if (quality) {
    params.set("q", String(typeof quality === "string" ? TIER_VALUES[quality] : quality));
  }
  return `/_next/image?${params.toString()}`;
}

/** The next/image loader for `url`. */
export function createDecoImageLoader(
  url: ImageUrl,
  options: DecoImageLoaderOptions = {},
): DecoImageLoader {
  const { fallback } = options;
  return (props) => {
    const { src, width, quality } = props;
    if (url.isOptimizable(src)) {
      return url(src, quality === undefined ? { width } : { width, quality });
    }
    return fallback?.(props) ?? src;
  };
}
