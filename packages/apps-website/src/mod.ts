/**
 * Website app module — standard autoconfig contract.
 *
 * Exports `configure` following the AppModContract pattern.
 * Provides SEO defaults, theme, matchers, and flags for the site.
 */

import type { AppDefinition, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import { configureWebsite } from "./client";
import type { Props as SecretProps } from "./loaders/secret";
import manifest from "./manifest.gen";
import type { WebsiteConfig } from "./types";

// -------------------------------------------------------------------------
// CMS Props (mirrors deco-cx/apps/website/mod.ts)
// -------------------------------------------------------------------------

export type Script = { src: string };

export interface CacheDirectiveBase {
	name: string;
	value: number;
}

export interface StaleWhileRevalidate extends CacheDirectiveBase {
	name: "stale-while-revalidate";
}

export interface MaxAge extends CacheDirectiveBase {
	name: "max-age";
}

export type CacheDirective = StaleWhileRevalidate | MaxAge;

export interface Caching {
	enabled?: boolean;
	directives?: CacheDirective[];
}

export interface AbTesting {
	enabled?: boolean;
	/** @description The name of the A/B test — appears in cookies */
	name?: string;
	matcher?: unknown;
	/** @description URL to run the A/B test against */
	urlToRunAgainst?: string;
	replaces?: unknown[];
	includeScriptsToHead?: { includes?: Script[] };
	includeScriptsToBody?: { includes?: Script[] };
}

/** @titleBy framework */
export interface FreshFlavor {
	/** @default fresh */
	framework: "fresh";
}

/** @titleBy framework */
export interface HtmxFlavor {
	/** @default htmx */
	framework: "htmx";
}

/** @title Website */
export interface Props {
	/** @title Routes Map */
	routes?: unknown[];

	/** @title Global Sections */
	global?: unknown[];

	/** @title Error Page */
	errorPage?: unknown;

	/** @title Caching configuration of pages */
	caching?: Caching;

	/**
	 * @title Global Async Rendering (Deprecated)
	 * @deprecated true
	 * @default false
	 */
	firstByteThresholdMS?: boolean;

	/** @title Avoid redirecting to editor */
	avoidRedirectingToEditor?: boolean;

	/** @title AB Testing */
	abTesting?: AbTesting;

	/** @title Flavor */
	flavor?: FreshFlavor | HtmxFlavor;

	/** @title Seo */
	seo?: Record<string, unknown>;

	/** @title Theme */
	theme?: unknown;

	/** @hide true */
	sendToClickHouse?: boolean;

	/** @title Default Image Quality */
	defaultImageQuality?: string;

	/** @title Disable image/asset proxy for this site */
	disableProxy?: boolean;

	/** @title Whilelist URL Patterns */
	whilelistURLs?: string[];
}

/** Alias for site app bridges that extend website Props. */
export type WebsiteProps = Props;

/** Secret block shape in decofile (website/loaders/secret.ts). */
export type Secret = SecretProps;

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

export interface WebsiteState {
	config: WebsiteConfig;
}

// -------------------------------------------------------------------------
// Configure
// -------------------------------------------------------------------------

/**
 * Configure the Website app from CMS block data.
 * Always returns an AppDefinition (no required fields).
 */
export async function configure(
	// biome-ignore lint/suspicious/noExplicitAny: block data comes from CMS with no fixed schema
	block: any,
	_resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<WebsiteState>> {
	const config: WebsiteConfig = {
		seo: block?.seo,
	};

	configureWebsite(config);

	return {
		name: "website",
		manifest,
		state: { config },
	};
}

/** Placeholder preview for CMS editor. */
export const preview = undefined;
