/**
 * VTEX Intelligent Search autocomplete — suggestions + product results.
 *
 * Combines /autocomplete_suggestions/ and /product_search/ in parallel,
 * transforms IS products to schema.org via pickSku + toProduct.
 */
import { getVtexConfig, intelligentSearch as vtexIS } from "../client";
import { pickSku, toProduct as toSchemaProduct } from "../utils/transform";

export interface AutocompleteProps {
	query: string;
	count?: number;
	showSponsored?: boolean;
	placement?: string;
	fuzzy?: string;
}

export interface AutocompleteResult {
	searches: Array<{ term: string; count: number; attributes?: any[] }>;
	products: any[];
}

export async function autocompleteSearch(props: AutocompleteProps): Promise<AutocompleteResult> {
	const query = props.query || "";
	const count = props.count ?? 4;
	if (!query.trim()) return { searches: [], products: [] };

	try {
		const [suggestionsData, productsData] = await Promise.all([
			vtexIS<{
				searches: Array<{ term: string; count: number; attributes?: any[] }>;
			}>("/autocomplete_suggestions/", { query }),
			vtexIS<{ products: any[] }>("/product_search/", {
				query,
				count: String(count),
				showSponsored: props.showSponsored !== false ? "true" : "false",
				placement: props.placement ?? "top-search",
				fuzzy: props.fuzzy ?? "0",
			}),
		]);

		const config = getVtexConfig();
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		return {
			searches: suggestionsData.searches ?? [],
			products: (productsData.products ?? []).slice(0, count).map((p: any) => {
				const sku = pickSku(p);
				return toSchemaProduct(p, sku, 0, { baseUrl, priceCurrency: "BRL" });
			}),
		};
	} catch (error) {
		console.error("[vtex] autocompleteSearch error:", error);
		return { searches: [], products: [] };
	}
}
