"use client";
/**
 * `Image`, `Picture` and `Source`: v7's components (`@decocms/blocks` 7.x
 * `hooks/Image.tsx` and `hooks/Picture.tsx`) with the same props and the same
 * markup, so call sites move by changing the import. The URLs come from an
 * `ImageUrl` (`@decocms/blocks/image`) instead of v7's module-wide
 * `registerImageCdnDomain` / `registerImageQuality`: wrap the app in
 * `<ImageUrlProvider value={imageUrl}>` with the site's own `createImageUrl`.
 *
 * This package knows no commerce platform. v7's components resized VTEX
 * catalog and Shopify images on those platforms' hosts; a site that shows
 * them lists the platform's helper first in its own `createImageUrl`
 * (`vtexCatalog()` from `@decocms/apps-vtex/image`, `shopifyCdn()` from
 * `@decocms/apps-shopify/image`), then `decoCdn({ sources: "all" })`, and
 * gets v7's URLs byte for byte. Without a provider every source goes through
 * the Deco image CDN (`assets.decocms.com`, the CDN's default quality):
 * {@link DECO_IMAGE_URL}.
 *
 * Difference from v7, on purpose: no "Missing height" warning on every render.
 */
import {
  createImageUrl,
  decoCdn,
  type Fit,
  type ImageUrl,
  srcSet as srcSetOf,
} from "@decocms/blocks/image";
import {
  type ComponentPropsWithoutRef,
  type Context,
  createContext,
  forwardRef,
  type ImgHTMLAttributes,
  type ReactNode,
  useContext,
  useMemo,
} from "react";

/**
 * The URLs without an `ImageUrlProvider`: every source through the Deco image
 * CDN, as v7 sent every source that wasn't a VTEX catalog or Shopify image.
 */
export const DECO_IMAGE_URL: ImageUrl = createImageUrl({
  providers: [decoCdn({ sources: "all" })],
});

interface Contexts {
  imageUrl: Context<ImageUrl>;
  preload: Context<{ preload: boolean }>;
}

// One pair of contexts per process even if a bundler duplicates this module,
// so a provider always reaches its components.
const KEY = Symbol.for("decocms.tanstack.imageContexts");
const holder = globalThis as unknown as Record<symbol, Contexts | undefined>;
const contexts: Contexts = holder[KEY] ?? {
  imageUrl: createContext<ImageUrl>(DECO_IMAGE_URL),
  preload: createContext({ preload: false }),
};
holder[KEY] = contexts;

/** The site's image URLs for every `Image`, `Picture` and `Source` below it. */
export function ImageUrlProvider({ value, children }: { value: ImageUrl; children?: ReactNode }) {
  return <contexts.imageUrl.Provider value={value}>{children}</contexts.imageUrl.Provider>;
}

/** The `ImageUrl` the nearest `ImageUrlProvider` gives ({@link DECO_IMAGE_URL} without one). */
export function useImageUrl(): ImageUrl {
  return useContext(contexts.imageUrl);
}

const DEFAULT_SIZES = "(max-width: 768px) 100vw, 50vw";

export interface ImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> {
  src: string;
  /** @description Improves Web Vitals (CLS/LCP) */
  width: number;
  /** @description Improves Web Vitals (CLS/LCP) */
  height?: number;
  /** @description Object-fit */
  fit?: Fit;
  /**
   * @description Web Vitals (LCP). Injects a `<link rel="preload">` tag
   * alongside the `<img>`, sets `fetchPriority="high"` and `loading="eager"`.
   * Use once per page for the LCP image.
   */
  preload?: boolean;
  /** @description Media query for responsive preloading (e.g. "(min-width: 768px)") */
  media?: string;
}

export const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  {
    src,
    width,
    height,
    fit = "cover",
    preload,
    media,
    loading,
    decoding,
    srcSet: srcSetProp,
    sizes,
    fetchPriority,
    ...rest
  },
  ref,
) {
  const url = useImageUrl();
  const optimizedSrc = url(src, { width, height, fit });
  const srcSet = srcSetProp ?? srcSetOf(url, src, { width, height, fit });
  const resolvedSizes = srcSet ? (sizes ?? DEFAULT_SIZES) : undefined;

  return (
    <>
      {preload && (
        <link
          as="image"
          rel="preload"
          href={optimizedSrc}
          imageSrcSet={srcSet}
          imageSizes={resolvedSizes}
          fetchPriority={fetchPriority ?? "high"}
          media={media}
        />
      )}
      {/* biome-ignore lint/a11y/useAltText: alt comes from the caller's props, as in v7 */}
      <img
        {...rest}
        src={optimizedSrc}
        srcSet={srcSet}
        sizes={resolvedSizes}
        width={width}
        height={height}
        loading={loading ?? (preload ? "eager" : "lazy")}
        decoding={decoding ?? "async"}
        fetchPriority={preload ? "high" : fetchPriority}
        ref={ref}
      />
    </>
  );
});

export type SourceProps = Omit<ComponentPropsWithoutRef<"source">, "width" | "height"> & {
  src: string;
  /** @description Improves Web Vitals (CLS|LCP) */
  width: number;
  /** @description Improves Web Vitals (CLS|LCP) */
  height?: number;
  /** @description Improves Web Vitals (LCP). Use high for LCP image. */
  fetchPriority?: "high" | "low" | "auto";
  /** @description Object-fit */
  fit?: Fit;
};

/** A `<source>` with its srcset built for it; inside `<Picture preload>`, it also preloads for its media query. */
export const Source = forwardRef<HTMLSourceElement, SourceProps>(function Source(
  { src, width, height, fetchPriority, fit = "cover", ...rest },
  ref,
) {
  const { preload } = useContext(contexts.preload);
  const url = useImageUrl();
  const optimizedSrc = url(src, { width, height, fit });
  const srcSet = rest.srcSet ?? srcSetOf(url, src, { width, height, fit });

  return (
    <>
      {preload && (
        <link
          as="image"
          rel="preload"
          href={optimizedSrc}
          imageSrcSet={srcSet}
          fetchPriority={fetchPriority ?? "high"}
          media={rest.media}
        />
      )}
      <source {...rest} srcSet={srcSet ?? optimizedSrc} width={width} height={height} ref={ref} />
    </>
  );
});

export type PictureProps = ComponentPropsWithoutRef<"picture"> & {
  children: ReactNode;
  /** @description When true, child `<Source>` elements inject `<link rel="preload">` tags for their media queries. */
  preload?: boolean;
};

/**
 * Art direction: `<Source>`s per media query and an `<Image>` fallback.
 *
 * ```tsx
 * <Picture preload={isLcp}>
 *   <Source media="(max-width: 767px)" src={mobile} width={320} height={280} />
 *   <Source media="(min-width: 768px)" src={desktop} width={1280} height={280} />
 *   <Image src={desktop} width={1280} height={280} />
 * </Picture>
 * ```
 */
export const Picture = forwardRef<HTMLPictureElement, PictureProps>(function Picture(
  { children, preload = false, ...props },
  ref,
) {
  const value = useMemo(() => ({ preload }), [preload]);
  return (
    <contexts.preload.Provider value={value}>
      <picture {...props} ref={ref}>
        {children}
      </picture>
    </contexts.preload.Provider>
  );
});
