/**
 * The VTEX upstream client: typed request functions over the framework's
 * instrumented fetch (`@decocms/blocks/fetch`). See /next/upstream-clients.
 *
 * ```ts
 * import { createVtexClient } from "@decocms/apps-vtex";
 *
 * export const vtex = createVtexClient({
 *   account: process.env.VTEX_ACCOUNT!,
 *   appKey: process.env.VTEX_APP_KEY!,
 *   appToken: process.env.VTEX_APP_TOKEN!,
 * });
 *
 * const result = await vtex.search.products({ query: "linen shirt", count: 12 });
 * ```
 *
 * Thin by design: it returns VTEX's own types, takes every setting and every
 * per-shopper input (cookies, region) as arguments, and never reads the
 * incoming request, caches, or converts. Converters, hooks, cart/session/sign-in
 * flows and loaders live in the VTEX platform template and site code; upstream
 * caching lives in the site (/next/caching#upstream-data), keyed
 * by everything a response depends on, such as `regionId`.
 *
 * Retries and a circuit breaker are ON by default for VTEX (and only for
 * VTEX). Retries apply to idempotent requests only, so a checkout POST is
 * never repeated. Pass `retry: false` / `circuitBreaker: false` to turn them off.
 */
import { createInstrumentedFetch } from "@decocms/blocks/fetch";
import { DEFAULT_RESILIENCE_CONFIG } from "./utils/constants";
import { sanitizeOutboundCookieHeader } from "./utils/cookieSanitizer";
import { vtexOperationRouter } from "./utils/operationRouter";
import type {
	Category,
	FacetSearchResult,
	Fuzzy,
	LegacyProduct,
	LegacySort,
	CrossSellingType,
	OrderForm,
	OrderFormItemInput,
	PageType,
	ProductSearchResult,
	SelectedFacet,
	Session,
	SimulationBehavior,
	SimulationOrderForm,
	Sort,
	Suggestion,
} from "./utils/types";

export interface VtexClientConfig {
	/** The VTEX account name, e.g. `mystore`. */
	account: string;
	/** Sent as `X-VTEX-API-AppKey` when set together with `appToken`. */
	appKey?: string;
	/** Sent as `X-VTEX-API-AppToken` when set together with `appKey`. */
	appToken?: string;
	/** @default "vtexcommercestable" */
	environment?: string;
	/** @default "com.br" */
	domain?: string;
	/** Default sales channel (`sc`), overridable per call where VTEX accepts one. */
	salesChannel?: string;
	/** Default Intelligent Search locale, e.g. `pt-BR`. */
	locale?: string;
	/** The fetch underneath; for tests. Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** On by default (2 retries, 150ms backoff); idempotent requests only. `false` turns it off. */
	retry?: { attempts: number; backoffMs?: number } | false;
	/** On by default (opens after 5 failures, for 5s). `false` turns it off. */
	circuitBreaker?: { failures: number; cooldownMs: number } | false;
}

const VTEX_DEFAULT_RETRY = {
	attempts: DEFAULT_RESILIENCE_CONFIG.maxRetries,
	backoffMs: DEFAULT_RESILIENCE_CONFIG.backoffBaseMs,
} as const;

const VTEX_DEFAULT_CIRCUIT_BREAKER = {
	failures: DEFAULT_RESILIENCE_CONFIG.breakerConsecutiveFailures,
	cooldownMs: DEFAULT_RESILIENCE_CONFIG.breakerOpenCooldownMs,
} as const;

/** Per-call inputs. Nothing is read from the incoming request. */
export interface VtexRequestOptions {
	/** The shopper's `Cookie` header to forward (non-ASCII and malformed pairs are dropped). */
	cookie?: string;
	signal?: AbortSignal;
}

/** A shopper-scoped response: the body plus VTEX's `Set-Cookie` values, unmodified, for the caller to forward. */
export interface VtexResponse<T> {
	data: T;
	setCookies: string[];
}

/** A failed VTEX call. Carries the operation and the status, never a body, URL, token or cookie. */
export class VtexError extends Error {
	constructor(
		readonly operation: string,
		readonly status: number,
	) {
		super(`vtex ${operation} failed with HTTP ${status}`);
		this.name = "VtexError";
	}
}

/** Intelligent Search arguments, mirroring its query parameters. */
export interface VtexSearchArgs extends VtexRequestOptions {
	query?: string;
	/** Selected facets, sent as the path (`category-1/shirts/brand/acme`). */
	facets?: SelectedFacet[];
	/** Intelligent Search's 1-based page. */
	page?: number;
	count?: number;
	sort?: Sort;
	fuzzy?: Fuzzy;
	locale?: string;
	hideUnavailableItems?: boolean;
	simulationBehavior?: SimulationBehavior;
	/** The shopper's region (from the `vtex_segment` cookie); part of the cache key. */
	regionId?: string;
	salesChannel?: string;
}

/** Legacy Catalog search arguments (`/api/catalog_system/pub/products/search`). */
export interface VtexCatalogSearchArgs extends VtexRequestOptions {
	/** Path term, e.g. a category path. */
	term?: string;
	/** Full-text query (`ft`). */
	ft?: string;
	/** Filter queries (`fq`), e.g. `productId:123`. */
	fq?: string[];
	/** `_from`, 0-based inclusive. */
	from?: number;
	/** `_to`, 0-based inclusive. */
	to?: number;
	/** `O`. */
	sort?: LegacySort;
	salesChannel?: string;
}

interface CallInit extends VtexRequestOptions {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
}

/**
 * Encodes a caller-supplied path (e.g. the shopper's URL path) segment by
 * segment, so it can't climb out of its endpoint (`..`, `%2e%2e`) or inject a
 * query (`?`, `#`) while the app credentials are attached.
 */
function pathSegments(path: string): string {
	return path
		.split("/")
		.filter((segment) => segment !== "")
		.map((segment) => {
			if (/^(\.|%2e){1,2}$/i.test(segment)) throw new Error("vtex: invalid path segment");
			return encodeURIComponent(segment);
		})
		.join("/");
}

export function createVtexClient(config: VtexClientConfig) {
	const host = `${config.account}.${config.environment ?? "vtexcommercestable"}.${config.domain ?? "com.br"}`;
	const base = `https://${host}`;
	const request = createInstrumentedFetch({
		provider: "vtex",
		fetch: config.fetch,
		retry: config.retry === false ? undefined : (config.retry ?? VTEX_DEFAULT_RETRY),
		circuitBreaker:
			config.circuitBreaker === false
				? undefined
				: (config.circuitBreaker ?? VTEX_DEFAULT_CIRCUIT_BREAKER),
	});

	async function call(url: string | URL, init: CallInit = {}): Promise<Response> {
		const method = (init.method ?? "GET").toUpperCase();
		const operation = vtexOperationRouter(String(url), method) ?? "unknown";
		const headers = new Headers({ accept: "application/json", ...init.headers });
		if (init.body !== undefined) headers.set("content-type", "application/json");
		// Shopper-scoped calls go out as the shopper only: with app credentials
		// VTEX would answer an orderForm with the profile data unmasked.
		if (config.appKey && config.appToken && !init.cookie) {
			headers.set("x-vtex-api-appkey", config.appKey);
			headers.set("x-vtex-api-apptoken", config.appToken);
		}
		if (init.cookie) {
			const { cookies } = sanitizeOutboundCookieHeader(init.cookie);
			if (cookies) headers.set("cookie", cookies);
		}
		const response = await request(url, {
			method,
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: init.signal,
			operation,
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new VtexError(operation, response.status);
		}
		return response;
	}

	/** Only the per-call request options, never the operation's other arguments. */
	const pick = (options: VtexRequestOptions = {}): VtexRequestOptions => ({
		cookie: options.cookie,
		signal: options.signal,
	});

	const json = async <T>(url: string | URL, init?: CallInit): Promise<T> =>
		(await call(url, init)).json() as Promise<T>;

	const withCookies = async <T>(url: string | URL, init?: CallInit): Promise<VtexResponse<T>> => {
		const response = await call(url, init);
		const setCookies =
			typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
		return { data: (await response.json()) as T, setCookies };
	};

	const url = (path: string, params: Record<string, string | number | boolean | undefined> = {}) => {
		const result = new URL(path, base);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") result.searchParams.set(key, String(value));
		}
		return result;
	};

	const isUrl = (endpoint: string, args: VtexSearchArgs) => {
		const facetPath = (args.facets ?? [])
			.map(({ key, value }) =>
				key ? `${encodeURIComponent(key)}/${encodeURIComponent(value)}` : encodeURIComponent(value),
			)
			.join("/");
		return url(`/api/io/_v/api/intelligent-search/${endpoint}/${facetPath}`, {
			query: args.query,
			page: args.page,
			count: args.count,
			sort: args.sort,
			fuzzy: args.fuzzy,
			locale: args.locale ?? config.locale,
			hideUnavailableItems: args.hideUnavailableItems,
			simulationBehavior: args.simulationBehavior,
			regionId: args.regionId,
			sc: args.salesChannel ?? config.salesChannel,
		});
	};

	const orderFormPath = (orderFormId: string, rest = "") =>
		`/api/checkout/pub/orderForm/${encodeURIComponent(orderFormId)}${rest}`;

	return {
		/** Intelligent Search. */
		search: {
			products: (args: VtexSearchArgs = {}) =>
				json<ProductSearchResult>(isUrl("product_search", args), pick(args)),
			facets: (args: VtexSearchArgs = {}) => json<FacetSearchResult>(isUrl("facets", args), pick(args)),
			suggestions: (args: VtexSearchArgs) =>
				json<Suggestion>(isUrl("search_suggestions", { ...args, facets: [] }), pick(args)),
			autocomplete: (args: VtexSearchArgs) =>
				json<Suggestion>(isUrl("autocomplete_suggestions", { ...args, facets: [] }), pick(args)),
			topSearches: (args: VtexSearchArgs = {}) =>
				json<Suggestion>(isUrl("top_searches", { ...args, facets: [] }), pick(args)),
		},

		/** Legacy Catalog API. */
		catalog: {
			pageType: async (path: string, options?: VtexRequestOptions) =>
				json<PageType>(url(`/api/catalog_system/pub/portal/pagetype/${pathSegments(path)}`), options),
			products: async (args: VtexCatalogSearchArgs = {}) => {
				const target = url(
					`/api/catalog_system/pub/products/search/${pathSegments(args.term ?? "")}`,
					{
						ft: args.ft,
						_from: args.from,
						_to: args.to,
						O: args.sort,
						sc: args.salesChannel ?? config.salesChannel,
					},
				);
				for (const fq of args.fq ?? []) target.searchParams.append("fq", fq);
				return json<LegacyProduct[]>(target, pick(args));
			},
			crossSelling: (type: CrossSellingType, productId: string, options?: VtexRequestOptions) =>
				json<LegacyProduct[]>(
					url(
						`/api/catalog_system/pub/products/crossselling/${type}/${encodeURIComponent(productId)}`,
					),
					options,
				),
			categoryTree: (levels = 3, options?: VtexRequestOptions) =>
				json<Category[]>(url(`/api/catalog_system/pub/category/tree/${levels}`), options),
		},

		/** Checkout API. Cart calls are shopper-scoped and return VTEX's `Set-Cookie` values. */
		checkout: {
			/**
			 * Gets the shopper's cart from their `checkout.vtex.com` cookie, or creates one.
			 * Every section by default; `sections` narrows it (`expectedOrderFormSections`).
			 */
			orderForm: (options: VtexRequestOptions & { sections?: string[] } = {}) =>
				withCookies<OrderForm>(url("/api/checkout/pub/orderForm"), {
					...pick(options),
					method: "POST",
					body: options.sections ? { expectedOrderFormSections: options.sections } : {},
				}),
			addItems: (orderFormId: string, orderItems: OrderFormItemInput[], options?: VtexRequestOptions) =>
				withCookies<OrderForm>(url(orderFormPath(orderFormId, "/items")), {
					...options,
					method: "POST",
					body: { orderItems },
				}),
			updateItems: (
				orderFormId: string,
				orderItems: { index: number; quantity: number }[],
				options?: VtexRequestOptions,
			) =>
				withCookies<OrderForm>(url(orderFormPath(orderFormId, "/items/update")), {
					...options,
					method: "POST",
					body: { orderItems },
				}),
			addCoupon: (orderFormId: string, text: string, options?: VtexRequestOptions) =>
				withCookies<OrderForm>(url(orderFormPath(orderFormId, "/coupons")), {
					...options,
					method: "POST",
					body: { text },
				}),
			attachment: (
				orderFormId: string,
				name: string,
				body: Record<string, unknown>,
				options?: VtexRequestOptions,
			) =>
				withCookies<OrderForm>(
					url(orderFormPath(orderFormId, `/attachments/${encodeURIComponent(name)}`)),
					{ ...options, method: "POST", body },
				),
			simulation: (
				body: {
					items: { id: string; quantity: number; seller: string }[];
					postalCode?: string;
					country?: string;
				},
				options: VtexRequestOptions & { salesChannel?: string } = {},
			) =>
				json<SimulationOrderForm>(
					url("/api/checkout/pub/orderForms/simulation", {
						sc: options.salesChannel ?? config.salesChannel,
					}),
					{ ...pick(options), method: "POST", body },
				),
			/** The region (and its sellers) serving a postal code; its `id` is the `regionId`. */
			regions: (
				args: { postalCode: string; country: string; salesChannel?: string },
				options?: VtexRequestOptions,
			) =>
				json<{ id: string; sellers: { id: string; name: string }[] }[]>(
					url("/api/checkout/pub/regions", {
						postalCode: args.postalCode,
						country: args.country,
						sc: args.salesChannel ?? config.salesChannel,
					}),
					options,
				),
		},

		/** Session API. Shopper-scoped; returns VTEX's `Set-Cookie` values. */
		sessions: {
			get: (options: VtexRequestOptions & { items?: string[] } = {}) =>
				withCookies<Session>(
					url("/api/sessions", { items: options.items?.join(",") }),
					pick(options),
				),
			update: (publicProps: Record<string, { value: string }>, options?: VtexRequestOptions) =>
				withCookies<{ id: string; sessionToken?: string }>(url("/api/sessions"), {
					...options,
					method: "POST",
					body: { public: publicProps },
				}),
		},

		/** VTEX IO's private GraphQL endpoint (`{account}.myvtex.com`). */
		io: {
			graphql: async <T>(
				body: { query: string; variables?: Record<string, unknown>; operationName?: string },
				options?: VtexRequestOptions,
			): Promise<T> => {
				const result = await json<{ data: T; errors?: unknown[] }>(
					`https://${config.account}.myvtex.com/_v/private/graphql/v1`,
					{ ...options, method: "POST", body },
				);
				// GraphQL errors arrive with HTTP 200; their messages can echo inputs, so they stay out.
				if (result.errors?.length) throw new VtexError("io.graphql", 200);
				return result.data;
			},
		},

		/** Master Data v1. */
		masterdata: {
			search: <T>(
				entity: string,
				args: VtexRequestOptions & {
					where?: string;
					fields?: string[];
					sort?: string;
					from?: number;
					to?: number;
				} = {},
			) =>
				json<T[]>(
					url(`/api/dataentities/${encodeURIComponent(entity)}/search`, {
						_where: args.where,
						_fields: args.fields?.join(","),
						_sort: args.sort,
					}),
					{
						...pick(args),
						headers: { "rest-range": `resources=${args.from ?? 0}-${args.to ?? 10}` },
					},
				),
			create: (entity: string, document: Record<string, unknown>, options?: VtexRequestOptions) =>
				json<{ Id: string; Href: string; DocumentId: string }>(
					url(`/api/dataentities/${encodeURIComponent(entity)}/documents`),
					{ ...options, method: "POST", body: document },
				),
		},
	};
}

export type VtexClient = ReturnType<typeof createVtexClient>;
