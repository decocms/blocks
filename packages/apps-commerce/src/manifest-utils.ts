/**
 * Utilities for extracting individual handlers from app manifests.
 *
 * Used by the framework to flatten module namespace imports into
 * individual handler functions for setInvokeLoaders() / setInvokeActions().
 */

import type { AppManifest } from "./app-types";

/**
 * Extract individual handler functions from a manifest's module namespaces.
 *
 * Given a manifest with:
 *   loaders: { "vtex/loaders/catalog": { searchProducts, getProductByIdOrSku } }
 *
 * Returns:
 *   { "vtex/loaders/catalog/searchProducts": searchProducts, ... }
 */
type AnyFn = (...args: never[]) => unknown;

export function extractHandlers(manifest: AppManifest): Record<string, AnyFn> {
	const result: Record<string, AnyFn> = {};

	for (const category of ["loaders", "actions"] as const) {
		const modules = manifest[category];
		for (const [moduleKey, moduleNamespace] of Object.entries(modules)) {
			for (const [exportName, handler] of Object.entries(
				moduleNamespace as Record<string, unknown>,
			)) {
				if (typeof handler === "function") {
					result[`${moduleKey}/${exportName}`] = handler as AnyFn;
				}
			}
		}
	}

	return result;
}
