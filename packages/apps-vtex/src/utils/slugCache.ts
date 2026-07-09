/**
 * In-flight dedup + SWR cache for VTEX Legacy Catalog slug→product lookups.
 *
 * Multiple loaders on the same page (PDP, relatedProducts x3, BuyTogether)
 * all call `/api/catalog_system/pub/products/search/{slug}/p` for the same slug.
 * This module routes through vtexCachedFetch which provides in-flight dedup
 * and stale-while-revalidate caching (3 min TTL for 200 responses).
 */
import { getVtexConfig, vtexCachedFetch } from "../client";
import type { LegacyProduct } from "./types";

export function searchBySlug(linkText: string): Promise<LegacyProduct[] | null> {
	const config = getVtexConfig();
	const sc = config.salesChannel;
	const scParam = sc ? `?sc=${sc}` : "";

	return vtexCachedFetch<LegacyProduct[]>(
		`/api/catalog_system/pub/products/search/${encodeURIComponent(linkText)}/p${scParam}`,
	).catch((err) => {
		console.error(`[VTEX] searchBySlug error for "${linkText}":`, err);
		return null;
	});
}

export async function resolveProductIdBySlug(linkText: string): Promise<string | null> {
	const products = await searchBySlug(linkText);
	return products?.length ? products[0].productId : null;
}
