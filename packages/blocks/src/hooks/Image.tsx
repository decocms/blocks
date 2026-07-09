import type { ImgHTMLAttributes } from "react";
import { forwardRef } from "react";

// -------------------------------------------------------------------------
// Known asset prefixes that get stripped to produce a relative src path
// -------------------------------------------------------------------------

const DECO_CACHE_URL = "https://assets.decocache.com/";
const S3_URL = "https://deco-sites-assets.s3.sa-east-1.amazonaws.com/";

// -------------------------------------------------------------------------
// Configurable CDN domain
// -------------------------------------------------------------------------

let imageCdnDomain = "decoims.com";

/**
 * Register the image CDN domain used by `getOptimizedMediaUrl`.
 * Call once in your site's setup.ts before any page loads.
 *
 * Available domains:
 * - `decoims.com` (Cloudflare, default — best compression, same edge as Workers)
 * - `deco-assets.edgedeco.com` (Azion IMS)
 * - `deco-assets.decoazn.com` (Azion IMS, legacy)
 */
export function registerImageCdnDomain(domain: string) {
	imageCdnDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function getImageCdnDomain(): string {
	return imageCdnDomain;
}

// -------------------------------------------------------------------------
// Fit options & optimization types
// -------------------------------------------------------------------------

export type FitOptions = "contain" | "cover" | "fill";

export const FACTORS = [1, 2];

interface OptimizationOptions {
	originalSrc: string;
	width: number;
	height?: number;
	fit: FitOptions;
}

// -------------------------------------------------------------------------
// Platform-specific URL optimizers (fallbacks when the CDN can handle
// the native platform's resize syntax directly)
// -------------------------------------------------------------------------

function optimizeVTEX(originalSrc: string, width: number, height?: number): string {
	const src = new URL(originalSrc);
	const [slash, arquivos, ids, rawId, ...rest] = src.pathname.split("/");
	const [trueId] = rawId.split("-");

	src.pathname = [slash, arquivos, ids, `${trueId}-${width}-${height ?? width}`, ...rest].join("/");

	return src.href;
}

function optimizeShopify(originalSrc: string, width: number, height?: number): string {
	const url = new URL(originalSrc);
	url.searchParams.set("width", `${width}`);
	if (height) url.searchParams.set("height", `${height}`);
	url.searchParams.set("crop", "center");
	return url.href;
}

// -------------------------------------------------------------------------
// Core optimization function
// Ported from deco-cx/apps website/components/Image.tsx
// -------------------------------------------------------------------------

/**
 * Builds an optimized image URL.
 *
 * For Deco-hosted images (decocache / S3), strips the known prefix and
 * routes through the Deco image CDN for edge resize + format conversion.
 *
 * For platform-specific images (VTEX, Shopify), rewrites the URL using
 * the platform's native resize params — no CDN proxy needed.
 *
 * Data URIs are returned as-is.
 */
export function getOptimizedMediaUrl(opts: OptimizationOptions): string {
	const { originalSrc, width, height, fit } = opts;

	// Defensive: an upstream CMS payload occasionally has missing/null image
	// fields. Crashing the entire React tree on `undefined.startsWith` would
	// take down the whole page. Return an empty string so the resulting
	// `<img>` is rendered with no src — the browser shows the broken-image
	// placeholder and SSR completes cleanly.
	if (typeof originalSrc !== "string" || originalSrc.length === 0) {
		if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
			console.warn(
				`[Image] getOptimizedMediaUrl called with empty/undefined src — rendering empty src instead of crashing.`,
			);
		}
		return "";
	}

	if (originalSrc.startsWith("data:")) {
		return originalSrc;
	}

	if (/(vteximg\.com\.br|vtexassets\.com|myvtex\.com)\/arquivos\/ids\/\d+/.test(originalSrc)) {
		return optimizeVTEX(originalSrc, width, height);
	}

	if (originalSrc.startsWith("https://cdn.shopify.com")) {
		return optimizeShopify(originalSrc, width, height);
	}

	let imageSource = originalSrc.replace(DECO_CACHE_URL, "").replace(S3_URL, "").split("?")[0];

	// Already on the image CDN — strip the host so we don't proxy through ourselves.
	const cdnPrefix = `https://${imageCdnDomain}/`;
	if (imageSource.startsWith(cdnPrefix)) {
		imageSource = imageSource.slice(cdnPrefix.length);
	}

	const params = new URLSearchParams();
	params.set("fit", fit);
	params.set("width", `${width}`);
	if (height) params.set("height", `${height}`);

	return `https://${imageCdnDomain}/image?${params}&src=${imageSource}`;
}

/**
 * Generates a srcset string with responsive multipliers.
 */
export function getSrcSet(
	originalSrc: string,
	width: number,
	height?: number,
	fit?: FitOptions,
	factors: number[] = FACTORS,
): string | undefined {
	if (typeof originalSrc !== "string" || originalSrc.length === 0) {
		return undefined;
	}

	const entries: string[] = [];

	for (const factor of factors) {
		const w = Math.trunc(factor * width);
		const h = height ? Math.trunc(factor * height) : undefined;

		const src = getOptimizedMediaUrl({
			originalSrc,
			width: w,
			height: h,
			fit: fit ?? "cover",
		});

		if (src) {
			entries.push(`${src} ${w}w`);
		}
	}

	return entries.length > 0 ? entries.join(", ") : undefined;
}

// -------------------------------------------------------------------------
// Image component
// -------------------------------------------------------------------------

export interface ImageProps
	extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> {
	src: string;
	/** @description Improves Web Vitals (CLS/LCP) */
	width: number;
	/** @description Improves Web Vitals (CLS/LCP) */
	height?: number;
	/** @description Object-fit */
	fit?: FitOptions;
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
	if (!height && typeof process !== "undefined") {
		console.warn(`Missing height. This image will NOT be optimized: ${src}`);
	}

	const optimizedSrc = getOptimizedMediaUrl({
		originalSrc: src,
		width,
		height,
		fit,
	});
	const srcSet = srcSetProp ?? getSrcSet(src, width, height, fit);
	const resolvedSizes = srcSet ? (sizes ?? "(max-width: 768px) 100vw, 50vw") : undefined;

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

export default Image;
