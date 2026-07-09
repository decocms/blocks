/**
 * VTEX brand loaders.
 * Returns schema.org Brand[] matching the original deco-cx/apps format.
 *
 * @see https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pub/brand/list
 */

import type { Brand } from "@decocms/apps-commerce/types";
import { getVtexConfig, vtexFetch } from "../client";
import { toBrand } from "../utils/transform";
import type { Brand as BrandVTEX } from "../utils/types";

export interface ListBrandsOpts {
	/** When true, only returns active brands. @default false */
	filterInactive?: boolean;
}

/**
 * List brands from the VTEX catalog, transformed to schema.org Brand format.
 */
export async function listBrands(opts?: ListBrandsOpts): Promise<Brand[]> {
	const config = getVtexConfig();
	const baseUrl = `https://${config.account}.vteximg.com.br/arquivos/ids`;

	const brands = await vtexFetch<BrandVTEX[]>("/api/catalog_system/pub/brand/list");

	const filtered = opts?.filterInactive ? brands.filter((b) => b.isActive) : brands;

	return filtered.map((b) => toBrand(b, baseUrl));
}

/**
 * Get a single brand by ID, as schema.org Brand.
 */
export async function getBrandById(brandId: number): Promise<Brand | null> {
	try {
		const config = getVtexConfig();
		const baseUrl = `https://${config.account}.vteximg.com.br/arquivos/ids`;
		const brand = await vtexFetch<BrandVTEX>(`/api/catalog_system/pub/brand/${brandId}`);
		return toBrand(brand, baseUrl);
	} catch {
		return null;
	}
}
