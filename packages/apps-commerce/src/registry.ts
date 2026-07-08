/**
 * Shared types for the app-registry pattern consumed by
 * `@decocms/blocks-admin/apps/autoconfig`'s `autoconfigApps()`.
 *
 * Each platform package with a registrable app (e.g. `@decocms/apps-vtex`)
 * exports its own single-entry registry from its own `./registry` subpath —
 * sites import only the platform entries they actually use and compose their
 * own array. This file holds only the shared shape, not a static catalogue
 * (previously it was — see git history — but that required every platform to
 * live in one package; split by platform, no single package can hold a
 * complete static array without depending on every other platform package).
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

export type { AppRegistryEntry, AppRegistry };
