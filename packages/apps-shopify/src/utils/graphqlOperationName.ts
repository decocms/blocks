/**
 * Extract a semantic operation name from a GraphQL document.
 *
 * Used at the Shopify GraphQL client layer to stamp `init.operation`
 * on the outbound fetch. The framework then suffixes the integration
 * name (`shopify.<operation>`) onto the span and uses the same string
 * as the `fetch.operation` attribute + histogram label.
 *
 * Resolution order:
 *
 *   1. An explicit `operationName` argument (e.g. when the client
 *      received one alongside a multi-operation document) wins.
 *   2. If the document has exactly one named operation, that name
 *      is used.
 *   3. If the document has zero or many anonymous operations, we
 *      return `undefined` so the caller can fall back (typically to
 *      the URL-derived `storefront.graphql` / `admin.graphql`).
 *
 * The parser is deliberately a small regex pass, not a full GraphQL
 * tokenizer:
 *
 *   - GraphQL operation definitions live at the top level of the
 *     document, never nested inside other operations, fragments, or
 *     selection sets, so positional context isn't required to find
 *     them — only to not match the literal words `query` /
 *     `mutation` / `subscription` inside string values.
 *   - We strip block strings (`""" … """`), string literals
 *     (`"…"`), and `# …` comments before matching, which is enough
 *     to make false-positive matches inside comments / docs vanish.
 *
 * If a Shopify operation is ever sufficiently mis-named to break
 * this (unlikely, since the storefront SDK names them deliberately),
 * the caller can always set `init.operation` explicitly.
 */

const OPERATION_RE = /\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

const stripCommentsAndStrings = (doc: string): string =>
	doc
		.replace(/"""[\s\S]*?"""/g, '""')
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/#[^\n]*/g, "");

export function extractGraphqlOperationName(
	document: string,
	explicit?: string,
): string | undefined {
	if (explicit) return explicit;
	if (!document) return undefined;

	const stripped = stripCommentsAndStrings(document);
	const names: string[] = [];

	OPERATION_RE.lastIndex = 0;
	for (
		let match = OPERATION_RE.exec(stripped);
		match !== null;
		match = OPERATION_RE.exec(stripped)
	) {
		const [, name] = match;
		if (name) names.push(name);
		if (names.length > 1) break;
	}

	if (names.length === 1) return names[0];
	return undefined;
}
