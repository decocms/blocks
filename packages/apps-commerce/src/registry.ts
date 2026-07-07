/**
 * Declarative catalogue of installable apps published under `@decocms/apps`.
 *
 * `@decocms/blocks-admin/apps/autoconfig`'s `autoconfigApps()` consumes this
 * array to wire CMS commerce loaders and admin invoke handlers for whichever
 * apps the host site has configured in its decofile. New apps are added
 * here — no edit to the framework or the site is required.
 *
 * Import path: `@decocms/apps-commerce/registry`
 *
 * NOTE: the type is inlined rather than imported from
 * `@decocms/blocks-admin/apps` so this file ships in `@decocms/apps-commerce`
 * against any installed `@decocms/blocks-admin` version. Once callers pin a
 * blocks-admin version that exposes `AppRegistry`, the type can be swapped.
 */

interface AppRegistryEntry {
	/** Block key in the decofile, e.g. "deco-shopify". */
	blockKey: string;
	/** Lazy dynamic import of the app's mod module. */
	module: () => Promise<any>;
	/** Human-readable name shown in admin install UI. */
	displayName?: string;
	/** Icon URL (absolute or site-relative) shown in admin install UI. */
	icon?: string;
	/** Grouping label, e.g. "commerce", "email", "analytics". */
	category?: string;
	/** Short summary shown in admin install UI. */
	description?: string;
}

type AppRegistry = readonly AppRegistryEntry[];

// KNOWN GAP (flagged during the apps-commerce migration, not resolved by this
// package): in apps-start these `module` factories were relative imports
// (`./shopify/mod` etc.) because commerce/ and shopify/, vtex/, resend/,
// blog/ were siblings inside one package. Now that each platform is its own
// `@decocms/apps-<platform>` package depending on `@decocms/apps-commerce`
// (one-way), pointing these at sibling packages (e.g.
// `@decocms/apps-shopify/mod`) would create the reverse edge and a real
// dependency cycle (apps-commerce -> apps-shopify -> apps-commerce),
// violating the monorepo's one-way dependency rule. Left unresolved here
// rather than guessing a fix — needs a plan-level decision (e.g. registry
// moves to a site-level aggregator that depends on all platform packages,
// or entries become plain strings resolved by the consumer, not statically
// imported). See docs/apps-monorepo-migration-plan.md Task 2.
export const APP_REGISTRY: AppRegistry = [
	{
		blockKey: "deco-shopify",
		// @ts-expect-error — "./shopify/mod" no longer resolves from this
		// package; see the KNOWN GAP note above.
		module: () => import("./shopify/mod"),
		displayName: "Shopify",
		category: "commerce",
		description: "Shopify Storefront API commerce integration",
	},
	{
		blockKey: "deco-vtex",
		// @ts-expect-error — "./vtex/mod" no longer resolves from this
		// package; see the KNOWN GAP note above.
		module: () => import("./vtex/mod"),
		displayName: "VTEX",
		category: "commerce",
		description: "VTEX IO commerce integration",
	},
	{
		blockKey: "deco-resend",
		// @ts-expect-error — "./resend/mod" no longer resolves from this
		// package; see the KNOWN GAP note above.
		module: () => import("./resend/mod"),
		displayName: "Resend",
		category: "email",
		description: "Transactional email via Resend",
	},
	{
		blockKey: "deco-blog",
		// @ts-expect-error — "./blog/mod" no longer resolves from this
		// package; see the KNOWN GAP note above.
		module: () => import("./blog/mod"),
		displayName: "Blog",
		category: "content",
		description: "Blog posts, categories, and authors from CMS collections",
	},
];

export default APP_REGISTRY;
export type { AppRegistryEntry, AppRegistry };
