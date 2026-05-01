/**
 * Per-site migration configuration.
 *
 * Looks for `.deco-migrate.config.json` next to the source root. The file
 * is optional — without it the script falls back to a baked-in default set
 * of section-convention names that work for `casaevideo` and most other
 * Deco/VTEX sites that derived from the same template.
 *
 * The defaults are kept here (not in `transforms/section-conventions.ts`)
 * so that:
 *   1. They live alongside the schema that consumes them.
 *   2. They can be overridden per site without forking the transform.
 *   3. Other phases (analyze, report) can read them too.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Names of section files that get framework hints applied during the
 * `transformSectionConventions` step.
 *
 * - `eagerSync`: render server-side eagerly *and* register as sync (no
 *   client-side defer).
 * - `sync`: register as sync (sectionLoaders.sync), but server-side
 *   loading remains the default.
 * - `listingCache`: `export const cache = "listing"` (medium TTL).
 * - `staticCache`: `export const cache = "static"` (long TTL).
 */
export interface SectionConventionConfig {
	eagerSync?: string[];
	sync?: string[];
	listingCache?: string[];
	staticCache?: string[];
}

export interface MigrateConfig {
	sectionConventions?: {
		/**
		 * Replace the built-in defaults entirely. Use only when porting a
		 * site whose section names don't overlap the defaults at all.
		 */
		replace?: SectionConventionConfig;
		/**
		 * Add to the built-in defaults. Recommended path for sites that
		 * share most defaults but have a few extra section names.
		 */
		extend?: SectionConventionConfig;
	};
}

/**
 * Resolved sets used by `transformSectionConventions`. Always provided —
 * either from defaults, from config replace, or defaults+config.extend.
 */
export interface SectionConventionSets {
	eagerSync: Set<string>;
	sync: Set<string>;
	listingCache: Set<string>;
	staticCache: Set<string>;
}

/**
 * Built-in defaults. Originally extracted from `casaevideo` migration —
 * these names are common across Deco/VTEX storefronts that share the
 * lineage. Sites that don't have these sections are unaffected (the
 * matcher just never fires).
 */
export const DEFAULT_SECTION_CONVENTIONS: SectionConventionConfig = {
	eagerSync: [
		"UtilLinks",
		"DepartamentList",
		"ImageGallery",
		"BannersGrid",
		"Carousel",
		"Tipbar",
		"Live",
	],
	sync: [
		"ProductShelf",
		"ProductShelfTabbed",
		"ProductShelfGroup",
		"ProductShelfTopSort",
		"CouponList",
		"NotFoundChallenge",
		"MountedPDP",
		"BackgroundWrapper",
		"SearchResult",
		"LpCartao",
	],
	listingCache: [
		"ProductShelf",
		"ProductShelfTabbed",
		"ProductShelfGroup",
		"ProductShelfTimedOffers",
	],
	staticCache: ["InstagramPosts", "Faq"],
};

/** Load `.deco-migrate.config.json` from the source dir, if present. */
export function loadConfig(sourceDir: string): MigrateConfig | null {
	const configPath = path.join(sourceDir, ".deco-migrate.config.json");
	if (!fs.existsSync(configPath)) return null;
	try {
		return JSON.parse(fs.readFileSync(configPath, "utf-8")) as MigrateConfig;
	} catch (e) {
		const msg = (e as Error).message;
		throw new Error(
			`Failed to parse ${configPath}: ${msg}. Expected valid JSON.`,
		);
	}
}

/** Resolve config + defaults into the four sets the transform consumes. */
export function resolveSectionConventions(
	config: MigrateConfig | null,
): SectionConventionSets {
	const sc = config?.sectionConventions;

	// Replace mode: use only what the user provided. No defaults mixed in.
	if (sc?.replace) {
		return toSets(sc.replace);
	}

	// Default + extend: start from defaults, union in extend lists.
	const merged: SectionConventionConfig = {
		eagerSync: [
			...(DEFAULT_SECTION_CONVENTIONS.eagerSync ?? []),
			...(sc?.extend?.eagerSync ?? []),
		],
		sync: [
			...(DEFAULT_SECTION_CONVENTIONS.sync ?? []),
			...(sc?.extend?.sync ?? []),
		],
		listingCache: [
			...(DEFAULT_SECTION_CONVENTIONS.listingCache ?? []),
			...(sc?.extend?.listingCache ?? []),
		],
		staticCache: [
			...(DEFAULT_SECTION_CONVENTIONS.staticCache ?? []),
			...(sc?.extend?.staticCache ?? []),
		],
	};
	return toSets(merged);
}

function toSets(c: SectionConventionConfig): SectionConventionSets {
	return {
		eagerSync: new Set(c.eagerSync ?? []),
		sync: new Set(c.sync ?? []),
		listingCache: new Set(c.listingCache ?? []),
		staticCache: new Set(c.staticCache ?? []),
	};
}

/** Cheap structural validation — throws on obviously invalid shapes. */
export function validateConfig(config: unknown): asserts config is MigrateConfig {
	if (config === null || typeof config !== "object") {
		throw new Error(".deco-migrate.config.json must be a JSON object");
	}
	const c = config as Record<string, unknown>;
	const sc = c.sectionConventions;
	if (sc === undefined) return;
	if (typeof sc !== "object" || sc === null) {
		throw new Error("sectionConventions must be an object");
	}
	const scObj = sc as Record<string, unknown>;
	for (const key of ["replace", "extend"] as const) {
		const v = scObj[key];
		if (v === undefined) continue;
		if (typeof v !== "object" || v === null) {
			throw new Error(`sectionConventions.${key} must be an object`);
		}
		const sub = v as Record<string, unknown>;
		for (const f of ["eagerSync", "sync", "listingCache", "staticCache"]) {
			const arr = sub[f];
			if (arr === undefined) continue;
			if (
				!Array.isArray(arr) ||
				!arr.every((s): s is string => typeof s === "string")
			) {
				throw new Error(`sectionConventions.${key}.${f} must be string[]`);
			}
		}
	}
}
