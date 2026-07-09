/**
 * Options for {@link relative}.
 *
 * `stripSearchParams` is the primitive escape hatch used by sites that
 * need to drop platform-specific query keys (commonly VTEX's `idsku`
 * / `skuId`) before linking to a PDP. Any keys not listed are kept.
 *
 * Sites previously hand-rolled this by forking `relative()` locally
 * with a `removeIdSku?: boolean` flag — see the migration guide and
 * the `local-framework-duplicate` audit rule in `@decocms/start`.
 */
export interface RelativeOptions {
	stripSearchParams?: string[];
}

/**
 * Convert an absolute or relative URL string into a path + search
 * fragment safe to feed into `<Link to={…} />` or `<a href={…}>`.
 *
 * - Returns `undefined` when `link` is falsy (the empty / undefined
 *   case is the common "no permalink yet" branch in product cards).
 * - Returns the original string when URL parsing fails — preserves
 *   pre-existing behaviour for malformed inputs.
 * - When `options.stripSearchParams` is non-empty, every listed key
 *   is removed from the resulting `?...` portion. Keys not present
 *   in the input are silently ignored. The pathname is never
 *   touched — only search params.
 *
 * @example
 *   relative("/p/foo");                                        // "/p/foo"
 *   relative("https://x.com/p/foo?a=1");                       // "/p/foo?a=1"
 *   relative("/p/foo?idsku=1&keep=2", {
 *     stripSearchParams: ["idsku"],
 *   });                                                         // "/p/foo?keep=2"
 *   relative(undefined);                                        // undefined
 */
export function relative(link?: string, options?: RelativeOptions): string | undefined {
	if (!link) return undefined;
	try {
		const linkUrl = new URL(link, "https://localhost");
		const stripKeys = options?.stripSearchParams;
		if (stripKeys && stripKeys.length > 0) {
			for (const key of stripKeys) {
				linkUrl.searchParams.delete(key);
			}
		}
		const search = linkUrl.searchParams.toString();
		return `${linkUrl.pathname}${search ? `?${search}` : ""}`;
	} catch {
		return link;
	}
}
