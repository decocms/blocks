/**
 * PDP default-path resolver.
 *
 * Ported from deco-cx/apps (`vtex/loaders/paths/PDPDefaultPath.ts`). When a
 * Product page is previewed/configured in the CMS, it is resolved at its raw
 * route pattern (`/:slug/p`), so the `slug` route-param comes through as the
 * literal placeholder `:slug` — there is no concrete product in the URL. Rather
 * than render a 404, we fall back to a real product — the best seller — so the
 * PDP has something to show in the admin.
 *
 * We query Intelligent Search for the top-selling, in-stock product and return
 * its `linkText` as the slug the PDP loader should render.
 */
import { intelligentSearch } from "../../client";

export interface PDPDefaultPathProps {
	/** How many candidate paths to fetch. Defaults to 1. */
	count?: number;
}

export interface DefaultPathResult {
	possiblePaths: string[];
}

export default async function PDPDefaultPath(
	props: PDPDefaultPathProps = {},
): Promise<DefaultPathResult | null> {
	const { count = 1 } = props;

	try {
		const data = await intelligentSearch<{ products?: Array<{ linkText?: string }> }>(
			"/product_search/",
			{
				page: "1",
				count: String(count),
				query: "",
				sort: "orders:desc",
				hideUnavailableItems: "true",
			},
		);

		const possiblePaths = (data.products ?? [])
			.map((p) => p.linkText)
			.filter((linkText): linkText is string => Boolean(linkText));

		return { possiblePaths };
	} catch (error) {
		console.error("[VTEX] PDPDefaultPath error:", error);
		return null;
	}
}
