import type { BreadcrumbList } from "../types/commerce";

export const canonicalFromBreadcrumblist = (b?: BreadcrumbList) => {
	const items = b?.itemListElement ?? [];
	if (!Array.isArray(items) || items.length === 0) return undefined;

	return items.reduce((acc, curr) => (acc.position < curr.position ? curr : acc)).item;
};
