/**
 * Public API for the website app.
 */

export { configureWebsite, getWebsiteConfig } from "./client";
// App
export { configure } from "./mod";

// Types
export type {
	FlagObj,
	Font,
	ImageWidget,
	MatchContext,
	Matcher,
	MultivariateFlag,
	OGType,
	SeoConfig,
	Variable,
	Variant,
	WebsiteConfig,
} from "./types";
