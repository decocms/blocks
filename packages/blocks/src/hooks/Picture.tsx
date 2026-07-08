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
// Created LAZILY (first render), not at module scope: this file has no
// "use client" directive, so in a react-server graph (a Server Component
// page, or ANY Next.js route handler — which ignores "use client"
// entirely) the module evaluates against React's react-server build, where
// `createContext` does not exist. A module-scope call crashes the whole
// graph at import time ("createContext is not a function") even if
// Picture/Source never render. Deferring to render time is safe: renders
// only ever happen under a full React build (client or SSR), and both
// components resolve the same memoized context object.
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
