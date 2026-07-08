/**
 * IS autocomplete suggestions loader.
 * Maps VTEX IS response to commerce Suggestion type.
 */

import type { Product, Suggestion } from "@decocms/apps-commerce/types";
import { getVtexConfig, intelligentSearch } from "../../client";
import { pickSku, toProduct } from "../../utils/transform";
import type { Product as ProductVTEX } from "../../utils/types";

export interface SuggestionsProps {
	query?: string;
	count?: number;
}

export default async function vtexSuggestions(props: SuggestionsProps): Promise<Suggestion | null> {
	const query = props.query || "";
	if (!query.trim()) return { searches: [], products: [] };

	try {
		const data = await intelligentSearch<{
			searches: Array<{ term: string; count: number }>;
			products: ProductVTEX[];
		}>("/autocomplete_suggestions/", { query });

		const searches = (data.searches ?? []).map((s) => ({
			term: s.term,
			hits: s.count || 0,
		}));

		const config = getVtexConfig();
		const baseUrl = config.publicUrl
			? `https://${config.publicUrl}`
			: `https://${config.account}.vtexcommercestable.${config.domain ?? "com.br"}`;

		const products: Product[] = (data.products ?? []).slice(0, props.count ?? 4).map((p) => {
			const sku = pickSku(p);
			return toProduct(p, sku, 0, { baseUrl, priceCurrency: "BRL" });
		});

		return { searches, products };
	} catch (error) {
		console.error("[VTEX] Suggestions error:", error);
		return null;
	}
}
