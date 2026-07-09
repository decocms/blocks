/**
 * Shopify app module — standard autoconfig contract.
 *
 * Exports `configure` following the AppModContract pattern.
 * The framework's `autoconfigApps()` calls these generically.
 *
 * @example
 * ```ts
 * import * as shopifyApp from "@decocms/apps/shopify/mod";
 *
 * const app = await shopifyApp.configure(blocks["deco-shopify"], resolveSecret);
 * if (app) {
 *   // app.manifest, app.state are available
 * }
 * ```
 */

import type { AppDefinition, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import { configureShopify, type ShopifyConfig } from "./client";
import manifest from "./manifest.gen";

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

export interface ShopifyState {
	config: ShopifyConfig;
}

// -------------------------------------------------------------------------
// Configure
// -------------------------------------------------------------------------

/**
 * Configure the Shopify app from CMS block data.
 * Returns an AppDefinition or null if required fields are missing.
 */
export async function configure(
	block: Record<string, unknown>,
	resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<ShopifyState> | null> {
	if (!block?.storeName) return null;

	const storefrontAccessToken =
		(await resolveSecret(block.storefrontAccessToken, "SHOPIFY_STOREFRONT_TOKEN")) ??
		(typeof block.storefrontAccessToken === "string" ? block.storefrontAccessToken : null);

	if (!storefrontAccessToken) return null;

	const config: ShopifyConfig = {
		storeName: block.storeName as string,
		storefrontAccessToken,
		publicUrl: block.publicUrl as string | undefined,
	};

	// Bridge: maintain global singleton for backward compat
	configureShopify(config);

	return {
		name: "shopify",
		manifest,
		state: { config },
	};
}

/** Placeholder preview for CMS editor — evolves when admin supports it. */
export const preview = undefined;
