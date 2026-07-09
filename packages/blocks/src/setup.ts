/**
 * One-call site bootstrap for the framework-agnostic parts of a site:
 * section registration, matchers, blocks, and CMS-resolution error
 * handling. Sites that also need the admin protocol (meta schema, render
 * shell, preview wrapper, commerce-loader-to-invoke wiring) call
 * createAdminSetup() from @decocms/blocks-admin alongside this — the two
 * were one function before the package split; they're split here because
 * createAdminSetup's concerns require importing from admin, and
 * runtime cannot depend on admin without creating a circular
 * dependency (admin already depends on runtime).
 *
 * Everything site-specific (section loaders, cacheable sections, async
 * rendering, layout sections, commerce loaders, sync sections) remains in
 * the site's own setup file — createSiteSetup only handles the
 * framework-generic wiring.
 */

import {
	loadBlocks,
	onBeforeResolve,
	registerSections,
	setBlocks,
	setDanglingReferenceHandler,
	setResolveErrorHandler,
} from "./cms/index";
import { registerBuiltinMatchers } from "./matchers/builtins";
import { registerProductionOrigins } from "./sdk/normalizeUrls";

export interface SiteSetupOptions {
	/**
	 * Section glob from Vite — pass `import.meta.glob("./sections/**\/*.tsx")`.
	 * Keys are transformed from `./sections/X.tsx` → `site/sections/X.tsx`.
	 */
	sections: Record<string, () => Promise<any>>;

	/**
	 * Generated blocks object — import and pass directly:
	 * `import { blocks } from "../.deco/blocks.gen";` (`.deco/blocks.gen.ts`
	 * is `generate-blocks.ts`'s default output location).
	 */
	blocks: Record<string, unknown>;

	/** Production origins for URL normalization. */
	productionOrigins?: string[];

	/**
	 * Custom matcher registrations to run alongside builtins.
	 * Each function is called once during setup.
	 */
	customMatchers?: Array<() => void>;

	/** Error handler for CMS resolution errors. */
	onResolveError?: (
		error: unknown,
		resolveType: string,
		context: string,
	) => void;

	/** Handler for dangling CMS references (missing __resolveType targets). */
	onDanglingReference?: (resolveType: string) => any;

	/**
	 * Called after blocks are loaded — use for platform initialization.
	 * Also called on every onBeforeResolve (decofile hot-reload).
	 */
	initPlatform?: (blocks: any) => void;
}

/**
 * Bootstrap a Deco site's framework-agnostic core — registers sections,
 * matchers, blocks, and error handlers. Call once at the top of your
 * setup.ts, before site-specific registrations, and alongside
 * createAdminSetup() (@decocms/blocks-admin) if the site also needs the
 * admin protocol.
 */
export function createSiteSetup(options: SiteSetupOptions): void {
	// 1. Error handlers (set first so they catch issues during registration)
	if (options.onResolveError) {
		setResolveErrorHandler(options.onResolveError);
	}
	if (options.onDanglingReference) {
		setDanglingReferenceHandler(options.onDanglingReference);
	}

	// 2. Section glob registration — transform Vite paths to CMS keys
	const sections: Record<string, () => Promise<any>> = {};
	for (const [path, loader] of Object.entries(options.sections)) {
		sections[`site/${path.slice(2)}`] = loader;
	}
	registerSections(sections);

	// 3. Matchers
	registerBuiltinMatchers();
	if (options.customMatchers) {
		for (const register of options.customMatchers) {
			register();
		}
	}

	// 4. Production origins
	if (options.productionOrigins?.length) {
		registerProductionOrigins(options.productionOrigins);
	}

	// 5. Blocks + platform init (server-only)
	if (typeof document === "undefined") {
		setBlocks(options.blocks);
		if (options.initPlatform) {
			options.initPlatform(loadBlocks());
		}
	}

	// 6. onBeforeResolve — re-init platform on decofile hot-reload
	if (options.initPlatform) {
		const init = options.initPlatform;
		onBeforeResolve(() => {
			init(loadBlocks());
		});
	}
}
