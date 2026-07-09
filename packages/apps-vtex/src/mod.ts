/**
 * VTEX app module — standard autoconfig contract.
 *
 * Exports `configure` following the AppModContract pattern.
 * The framework's `autoconfigApps()` calls these generically.
 *
 * @example
 * ```ts
 * import * as vtexApp from "@decocms/apps/vtex/mod";
 *
 * const app = await vtexApp.configure(blocks.vtex, resolveSecret);
 * if (app) {
 *   // app.manifest, app.state, app.middleware are available
 * }
 * ```
 */

import type { AppDefinition, AppMiddleware, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import type { Secret } from "@decocms/apps-website/mod";
import { configureVtex, type VtexConfig } from "./client";
import manifest from "./manifest.gen";
import { extractVtexContext, propagateISCookies, vtexCacheControl } from "./middleware";
import { registerVtexSchemas } from "./schemas";

// -------------------------------------------------------------------------
// CMS Props (mirrors deco-cx/apps/vtex/mod.ts)
// -------------------------------------------------------------------------

/** @title VTEX */
export interface Props {
	/**
	 * @description VTEX Account name
	 */
	account: string;

	/**
	 * @title Public store URL
	 * @description Domain registered on License Manager (e.g. secure.mystore.com.br)
	 */
	publicUrl: string;

	/** @title App Key */
	appKey?: Secret;

	/**
	 * @title App Token
	 * @format password
	 */
	appToken?: Secret;

	/**
	 * @title Default Sales Channel
	 * @deprecated
	 */
	salesChannel?: string;

	/**
	 * @title Set Refresh Token
	 * @default false
	 */
	setRefreshToken?: boolean;

	defaultSegment?: Record<string, unknown>;

	usePortalSitemap?: boolean;

	/**
	 * @hide true
	 * @default vtex
	 */
	platform?: "vtex";

	advancedConfigs?: {
		doNotFetchVariantsForRelatedProducts?: boolean;
		removeUTMFromCacheKey?: boolean;
	};

	/** @title Cached Search Terms */
	cachedSearchTerms?: {
		terms?: unknown;
		extraTerms?: string[];
	};
}

export type { Secret };

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

export interface VtexState {
	config: VtexConfig;
}

// -------------------------------------------------------------------------
// Middleware
// -------------------------------------------------------------------------

const vtexMiddleware: AppMiddleware = async (request, next) => {
	const ctx = extractVtexContext(request);
	const response = await next();
	response.headers.set("Cache-Control", vtexCacheControl(ctx));
	propagateISCookies(ctx, response);
	return response;
};

// -------------------------------------------------------------------------
// Configure
// -------------------------------------------------------------------------

/**
 * Configure the VTEX app from CMS block data.
 * Returns an AppDefinition or null if required fields are missing.
 */
export async function configure(
	// biome-ignore lint/suspicious/noExplicitAny: block data comes from CMS with no fixed schema
	block: any,
	resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<VtexState> | null> {
	if (!block?.account) return null;

	// Real props schemas for the admin meta — must be in place before
	// setupApps() auto-registers the __resolveType-only stubs.
	registerVtexSchemas();

	const appKey = await resolveSecret(block.appKey, "VTEX_APP_KEY");
	const appToken = await resolveSecret(block.appToken, "VTEX_APP_TOKEN");

	const config: VtexConfig = {
		account: block.account,
		publicUrl: block.publicUrl,
		salesChannel: block.salesChannel || "1",
		locale: block.locale || block.defaultLocale,
		appKey: appKey ?? undefined,
		appToken: appToken ?? undefined,
		country: block.country,
		domain: block.domain,
	};

	// Bridge: maintain global singleton for backward compat
	configureVtex(config);

	return {
		name: "vtex",
		manifest,
		state: { config },
		middleware: vtexMiddleware,
	};
}

/** Placeholder preview for CMS editor — evolves when admin supports it. */
export const preview = undefined;

/** Default export for schema generation and Deno-style app bridges. */
export default function VTEX(_props: Props) {
	return { state: _props };
}
