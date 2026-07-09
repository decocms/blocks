/**
 * URL-derived operation name router for VTEX API calls.
 *
 * Plugged into `@decocms/start`'s `createInstrumentedFetch` via the
 * `resolveOperation(url, method)` option. The resolved string becomes the
 * span suffix (`vtex.<operation>`) and the `fetch.operation` span +
 * histogram label, so it must be:
 *
 *   - low-cardinality (no IDs, slugs, search terms, account names);
 *   - stable across deploys (used for alerting + dashboards);
 *   - human-debuggable in a trace view.
 *
 * The router is intentionally a flat ordered list of regex matchers,
 * not a tree. Adding/auditing routes is a one-line patch and routes
 * are evaluated in priority order (most specific first). Unknown URLs
 * return `undefined` so the framework falls back to the generic
 * `vtex.fetch` span name — observable, just less specific.
 *
 * Callers that need finer granularity than the URL can express (e.g.
 * `POST /orderForm/{id}/items` is one URL but covers add / update /
 * remove flows) should set `init.operation` explicitly per call; that
 * always wins over the router.
 */

type OperationResolver = string | ((match: RegExpMatchArray, method: string) => string);

interface Matcher {
	pattern: RegExp;
	operation: OperationResolver;
}

const m = (pattern: RegExp, operation: OperationResolver): Matcher => ({ pattern, operation });

/**
 * Ordered list of `(regex, operation)` matchers. The first match wins.
 *
 * Patterns match against the URL pathname (the host is ignored — VTEX
 * spreads the same API surface across `*.vtexcommercestable.*`,
 * `*.myvtex.com`, and storefront origins, all on identical paths).
 *
 * Operation strings are bare (no `vtex.` prefix) — the framework
 * prefixes them with the integration name at span time.
 */
const MATCHERS: ReadonlyArray<Matcher> = [
	m(/^\/api\/io\/_v\/api\/intelligent-search\/([a-z_-]+)/, (mm) => `intelligent-search.${mm[1]}`),
	m(/^\/_v\/private\/graphql\/v1/, "io.graphql"),
	m(/^\/_v\/segment\//, "io.segment"),

	m(/^\/api\/checkout\/pub\/orderForm\/[^/]+\/items\/update/, (_mm, method) =>
		method === "POST" ? "checkout.orderform.items.update" : "checkout.orderform.items",
	),
	m(/^\/api\/checkout\/pub\/orderForm\/[^/]+\/items/, (_mm, method) => {
		if (method === "DELETE") return "checkout.orderform.items.remove";
		if (method === "PATCH" || method === "PUT") return "checkout.orderform.items.update";
		return "checkout.orderform.items.add";
	}),
	m(/^\/api\/checkout\/pub\/orderForm\/[^/]+\/coupons/, "checkout.orderform.coupons"),
	m(/^\/api\/checkout\/pub\/orderForm\/[^/]+\/profile/, "checkout.orderform.profile"),
	m(/^\/api\/checkout\/pub\/orderForm\/[^/]+\/shippingData/, "checkout.orderform.shipping"),
	m(/^\/api\/checkout\/pub\/orderForm\/[^/]+\/paymentData/, "checkout.orderform.payment"),
	m(/^\/api\/checkout\/pub\/orderForm\/[^/]+/, (_mm, method) =>
		method === "GET" ? "checkout.orderform.get" : "checkout.orderform.update",
	),
	m(/^\/api\/checkout\/pub\/orderForm(?:\/?$)/, (_mm, method) =>
		method === "POST" ? "checkout.orderform.create" : "checkout.orderform.get",
	),
	m(/^\/api\/checkout\/pub\/orderForms\/simulation/, "checkout.simulation"),
	m(/^\/api\/checkout\/pub\/regions/, "checkout.regions"),
	m(/^\/api\/checkout\/pub\/postal-code/, "checkout.postal-code"),

	m(/^\/api\/sessions/, (_mm, method) => (method === "POST" ? "sessions.update" : "sessions.get")),
	m(/^\/api\/segments\//, "segments.get"),

	m(/^\/api\/catalog_system\/pub\/portal\/pagetype\//, "catalog.pagetype"),
	m(
		/^\/api\/catalog_system\/pub\/products\/crossselling\/([^/]+)/,
		(mm) => `catalog.crossselling.${mm[1]}`,
	),
	m(/^\/api\/catalog_system\/pub\/products\/variations\//, "catalog.products.variations"),
	m(/^\/api\/catalog_system\/pub\/products\/search/, "catalog.products.search"),
	m(/^\/api\/catalog_system\/pub\/facets\/search/, "catalog.facets.search"),
	m(/^\/api\/catalog_system\/pub\/category\/tree/, "catalog.category.tree"),
	m(/^\/api\/catalog_system\/(?:pub|pvt)\/specification/, "catalog.specification"),
	m(/^\/api\/catalog_system\/pub\/brand/, "catalog.brand"),
	m(/^\/api\/catalog_system\/pvt\/sku\//, "catalog.sku"),
	m(/^\/api\/catalog_system\//, "catalog.other"),

	m(/^\/api\/wishlist\//, "wishlist"),
	m(/^\/api\/profile-system\/profile\//, "profile"),
	m(/^\/api\/dataentities\/([^/]+)/, (mm) => `masterdata.${mm[1]}`),

	m(/^\/api\/oms\/user\/orders\/[^/]+\/cancel/, "oms.orders.cancel"),
	m(/^\/api\/oms\/user\/orders/, "oms.orders"),
	m(/^\/api\/oms\/pvt\/orders/, "oms.orders.pvt"),

	m(/^\/api\/vtexid\/pub\/logout/, "vtexid.logout"),
	m(/^\/api\/vtexid\/pub\/authentication\/start/, "vtexid.authentication.start"),
	m(/^\/api\/vtexid\/pub\/authentication\/[a-z]+\/validate/, "vtexid.authentication.validate"),
	m(/^\/api\/vtexid\/pub\/authenticated\/user/, "vtexid.user"),
	m(/^\/api\/vtexid\//, "vtexid.other"),

	m(/^\/api\/events\/v1\//, "events.send"),
	m(/^\/sitemap.*\.xml$/, "sitemap"),
	m(/^\/api\/license-manager/, "license-manager"),
];

/**
 * Resolve an operation name for a VTEX URL. Returns `undefined` if no
 * matcher fires, which causes the framework to fall back to
 * `vtex.fetch`.
 *
 * Designed to be passed directly to `createInstrumentedFetch`:
 *
 * ```ts
 * createInstrumentedFetch({
 *   name: "vtex",
 *   resolveOperation: vtexOperationRouter,
 * });
 * ```
 */
export function vtexOperationRouter(url: string, method: string): string | undefined {
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
