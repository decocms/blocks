/**
 * Core types for the website app.
 *
 * Defines the matcher/flag system types locally so we don't depend on
 * @deco/deco/blocks — everything is self-contained in @decocms/apps.
 */

// -------------------------------------------------------------------------
// Script
// -------------------------------------------------------------------------

export type Script = { src: string | ((req: Request) => string) };

// -------------------------------------------------------------------------
// Matcher system
// -------------------------------------------------------------------------

/**
 * Context passed to matchers at request time.
 * The framework populates this from the incoming request.
 */
export interface MatchContext {
	request: Request;
	device: "mobile" | "tablet" | "desktop";
	siteId: number;
}

/**
 * A matcher is a function that evaluates request context and returns a boolean.
 */
export type Matcher = (ctx: MatchContext) => boolean;

// -------------------------------------------------------------------------
// Flag system
// -------------------------------------------------------------------------

/**
 * A feature flag with a matcher and two branches.
 * The framework evaluates the matcher at request time and selects the
 * appropriate branch value.
 */
export interface FlagObj<T> {
	matcher: Matcher;
	true: T;
	false: T;
	name: string;
}

/**
 * A multivariate flag with multiple variants, each with its own matcher.
 */
export interface MultivariateFlag<T> {
	variants: Variant<T>[];
}

/**
 * A single variant in a multivariate flag.
 */
export interface Variant<T> {
	matcher?: Matcher;
	value: T;
	weight?: number;
}

// -------------------------------------------------------------------------
// Theme / Font types
// -------------------------------------------------------------------------

export interface Variable {
	name: string;
	value: string;
}

export type Font = {
	family: string;
	styleSheet: string;
};

// -------------------------------------------------------------------------
// SEO types
// -------------------------------------------------------------------------

/** @description Recommended: 1200 x 630 px (up to 5MB) */
export type ImageWidget = string;

export type OGType = "website" | "article";

export interface SeoConfig {
	title?: string;
	/**
	 * @title Title template
	 * @description add a %s whenever you want it to be replaced with the product name, category name or search term
	 * @default %s
	 */
	titleTemplate?: string;
	description?: string;
	/**
	 * @title Description template
	 * @description add a %s whenever you want it to be replaced with the product name, category name or search term
	 * @default %s
	 */
	descriptionTemplate?: string;
	/** @default website */
	type?: OGType;
	/** @description Recommended: 1200 x 630 px (up to 5MB) */
	image?: ImageWidget;
	/** @description Recommended: 16 x 16 px */
	favicon?: ImageWidget;
	/** @description Suggested color that browsers should use to customize the display */
	themeColor?: string;
	/**
	 * @title Disable indexing
	 * @description In testing, you can use this to prevent search engines from indexing your site
	 */
	noIndexing?: boolean;
}

// -------------------------------------------------------------------------
// Website app config
// -------------------------------------------------------------------------

export interface WebsiteConfig {
	/** @title Seo */
	seo?: SeoConfig;
}
