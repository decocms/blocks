/**
 * Build REST-Range header values for VTEX paginated APIs.
 * Ported from deco-cx/apps vtex/utils/resourceRange.ts
 */
export function resourceRange(skip: number, take: number) {
	const from = Math.max(skip, 0);
	const to = from + Math.min(100, take);

	return { from, to };
}
