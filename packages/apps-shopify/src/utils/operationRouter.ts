/**
 * URL-derived operation name router for Shopify API calls.
 *
 * Plugged into `@decocms/start`'s `createInstrumentedFetch` via the
 * `resolveOperation(url, method)` option. Mirrors the shape of the
 * VTEX router in `../../vtex/utils/operationRouter.ts`.
 *
 * Shopify's API surface from this repo is overwhelmingly GraphQL —
 * a single endpoint per environment (storefront vs admin). That means
 * the URL alone can only tell us *which GraphQL surface* a call is
 * hitting, not what the call actually does. The semantic operation
 * name lives in the GraphQL document itself (`query Foo { ... }`),
 * and is extracted by `extractGraphqlOperationName` (see
 * `./graphqlOperationName.ts`) at the client layer and stamped as
 * `init.operation`, which always wins over this router.
 *
 * So this router exists for:
 *
 *   - non-GraphQL Shopify REST endpoints we may add later
 *     (cart API, customer accounts, billing, etc.);
 *   - giving the GraphQL endpoints a *fallback* operation when the
 *     extractor can't parse a name (anonymous queries, missing body).
 */

type OperationResolver = string | ((match: RegExpMatchArray, method: string) => string);

interface Matcher {
	pattern: RegExp;
	operation: OperationResolver;
}

const m = (pattern: RegExp, operation: OperationResolver): Matcher => ({ pattern, operation });

const MATCHERS: ReadonlyArray<Matcher> = [
	m(/^\/admin\/api\/[0-9]{4}-[0-9]{2}\/graphql\.json/, "admin.graphql"),
	m(/^\/api\/[0-9]{4}-[0-9]{2}\/graphql\.json/, "storefront.graphql"),

	m(/^\/admin\/api\/[0-9]{4}-[0-9]{2}\/products/, "admin.products"),
	m(/^\/admin\/api\/[0-9]{4}-[0-9]{2}\/orders/, "admin.orders"),
	m(/^\/admin\/api\/[0-9]{4}-[0-9]{2}\/customers/, "admin.customers"),
	m(/^\/admin\/api\/[0-9]{4}-[0-9]{2}\/inventory/, "admin.inventory"),

	m(/^\/api\/[0-9]{4}-[0-9]{2}\/checkouts/, "storefront.checkout"),
	m(/^\/cart(?:\/|\.js|$)/, "storefront.cart"),
];

/**
 * Resolve an operation name for a Shopify URL. Returns `undefined`
 * if no matcher fires, which causes the framework to fall back to
 * `shopify.fetch`.
 */
export function shopifyOperationRouter(url: string, method: string): string | undefined {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		const qs = url.indexOf("?");
		const hash = url.indexOf("#");
		const end = [qs, hash].filter((i) => i >= 0).sort((a, b) => a - b)[0];
		pathname = end === undefined ? url : url.slice(0, end);
	}

	const upperMethod = method.toUpperCase();
	for (const { pattern, operation } of MATCHERS) {
		const match = pathname.match(pattern);
		if (!match) continue;
		return typeof operation === "function" ? operation(match, upperMethod) : operation;
	}
	return undefined;
}
