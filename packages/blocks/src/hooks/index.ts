export { isBelowFold, LazySection, type LazySectionProps } from "./LazySection";
export { LiveControls } from "./LiveControls";
export { SectionErrorBoundary } from "./SectionErrorFallback";
export { default as RenderSection } from "./RenderSection";

// Commerce UI primitives (moved from apps-start's commerce/components/).
export {
	default as Image,
	registerImageCdnDomain,
	getImageCdnDomain,
	getOptimizedMediaUrl,
	getSrcSet,
	FACTORS,
	type ImageProps,
	type FitOptions,
} from "./Image";
export { Picture, Source, type PictureProps, type SourceProps } from "./Picture";
export {
	ProductJsonLd,
	PLPJsonLd,
	BreadcrumbJsonLd,
	seoMetaTags,
	type ProductJsonLdProps,
	type PLPJsonLdProps,
	type BreadcrumbJsonLdProps,
	type SeoMetaProps,
	type JsonLdProduct,
	type JsonLdProductListingPage,
	type JsonLdBreadcrumbList,
} from "./JsonLd";
