/**
 * Workflow/collection products loader using Intelligent Search + shared transform.
 * Maps IS response to schema.org Product[] following deco-cx/apps pattern.
 */

import type { Product } from "@decocms/apps-commerce/types";
import { getVtexConfig, intelligentSearch, toFacetPath } from "../../client";
import { pickSku, toProduct } from "../../utils/transform";
import type { Product as ProductVTEX } from "../../utils/types";

export interface WorkflowProductsProps {
	props?: {
		query?: string;
		count?: number;
		sort?: string;
		collection?: string;
	};
	page?: number;
	pagesize?: number;
}

export default async function vtexWorkflowProducts(
	props: WorkflowProductsProps,
): Promise<Product[] | null> {
	const inner = props.props ?? props;
	const collection = (inner as any).collection;
	const query = (inner as any).query ?? "";
	const count = (inner as any).count ?? props.pagesize ?? 12;
	const sort = (inner as any).sort ?? "";

	try {
		const config = getVtexConfig();
		const locale = config.locale ?? "pt-BR";

		const params: Record<string, string> = {
			count: String(count),
			locale,
			page: String((props.page ?? 0) + 1),
		};
		if (query) params.query = query;
		if (sort) params.sort = sort;

		const facetPath = collection
			? toFacetPath([{ key: "productClusterIds", value: collection }])
			: "";

		const endpoint = facetPath ? `/product_search/${facetPath}` : "/product_search/";

		const data = await intelligentSearch<{ products: ProductVTEX[] }>(endpoint, params);

		const products = data.products ?? [];
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		return products.map((p) => {
			const sku = pickSku(p);
			return toProduct(p, sku, 0, { baseUrl, priceCurrency: "BRL" });
		});
	} catch (error) {
		console.error("[VTEX] Workflow products error:", error);
		return null;
	}
}
