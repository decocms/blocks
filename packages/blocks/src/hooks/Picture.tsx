"use client";

// `"use client"` added by @decocms/nextjs's next-smoke fixture build
// (Picture is reachable from `DecoRootLayout`/`SectionRenderer` via the
// `hooks/index.ts` barrel, so it is part of the react-server module graph
// on any Next.js Server Component page even when a given page never
// renders it): `createContext`/`useContext` are unavailable under React's
// react-server condition, and Next statically flags any reachable module
// that imports them without this directive ("You're importing a component
// that needs createContext...") — same class of fix, same precedent, as
// `SectionErrorFallback.tsx`'s `"use client"` (class component /
// componentDidCatch, also client-only).
import {
	type ComponentPropsWithoutRef,
	type Context,
	createContext,
	forwardRef,
	type ReactNode,
	useContext,
	useMemo,
} from "react";
import { type FitOptions, getOptimizedMediaUrl, getSrcSet } from "./Image";

// -------------------------------------------------------------------------
// Preload context — flows from <Picture preload> to child <Source> elements
// so each source can inject its own <link rel="preload"> with the correct
// media query for responsive art direction.
//
// Still created LAZILY (first render, not module scope) even under
// `"use client"`: this keeps a single memoized context object regardless of
// how many client bundle chunks end up importing this module, rather than
// relying on module-instance identity across chunks.
// -------------------------------------------------------------------------

interface PreloadContextValue {
	preload: boolean;
}

let _preloadContext: Context<PreloadContextValue> | null = null;
function getPreloadContext(): Context<PreloadContextValue> {
	_preloadContext ??= createContext<PreloadContextValue>({ preload: false });
	return _preloadContext;
}

// -------------------------------------------------------------------------
// Source — composable <source> with automatic srcSet optimization and
// preload link injection when inside a <Picture preload>.
// -------------------------------------------------------------------------

export type SourceProps = Omit<ComponentPropsWithoutRef<"source">, "width" | "height"> & {
	src: string;
	/** @description Improves Web Vitals (CLS|LCP) */
	width: number;
	/** @description Improves Web Vitals (CLS|LCP) */
	height?: number;
	/** @description Improves Web Vitals (LCP). Use high for LCP image. */
	fetchPriority?: "high" | "low" | "auto";
	/** @description Object-fit */
	fit?: FitOptions;
};

export const Source = forwardRef<HTMLSourceElement, SourceProps>(function Source(
	{ src, width, height, fetchPriority, fit = "cover", ...rest },
	ref,
) {
	const { preload } = useContext(getPreloadContext());

	const optimizedSrc = getOptimizedMediaUrl({
		originalSrc: src,
		width,
		height,
		fit,
	});
	const srcSet = rest.srcSet ?? getSrcSet(src, width, height, fit);

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

// -------------------------------------------------------------------------
// Picture — composable wrapper that provides preload context to children.
//
// Usage:
//   <Picture preload={isLcp}>
//     <Source media="(max-width: 767px)" src={mobile} width={320} height={280} />
//     <Source media="(min-width: 768px)" src={desktop} width={1280} height={280} />
//     <Image src={desktop} width={1280} height={280} />
//   </Picture>
// -------------------------------------------------------------------------

export type PictureProps = ComponentPropsWithoutRef<"picture"> & {
	children: ReactNode;
	/**
	 * @description When true, child <Source> and <Image> elements inject
	 * `<link rel="preload">` tags for their respective media queries.
	 */
	preload?: boolean;
};

export const Picture = forwardRef<HTMLPictureElement, PictureProps>(function Picture(
	{ children, preload = false, ...props },
	ref,
) {
	const value = useMemo(() => ({ preload }), [preload]);
	const PreloadContext = getPreloadContext();

	return (
		<PreloadContext.Provider value={value}>
			<picture {...props} ref={ref}>
				{children}
			</picture>
		</PreloadContext.Provider>
	);
});
