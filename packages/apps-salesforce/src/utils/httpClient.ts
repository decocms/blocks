/**
 * Typed HTTP client compatible with deco-cx/apps' `createHttpClient`
 * signature. Accepts both the simple `.get(path)` / `.post(path, body)`
 * shape and the indexed-route shape used by legacy Deno loaders:
 *
 * ```ts
 * const client = createHttpClient({ base: "https://api.example.com" });
 * await client["POST /api2/event/:dataset"]({ dataset: "prod" }, { body });
 * await client.get("/healthcheck");
 * ```
 *
 * Runtime-agnostic: only requires the global `fetch`. Works on
 * Cloudflare Workers, Bun, Deno, and modern Node — no `node:http`
 * dependency. Returns `{ json, ok, status, headers }` from indexed
 * routes (mirrors the legacy `apps/utils/http.ts` shape so existing
 * loaders that call `.then(res => res.json())` keep working).
 */

import { createSalesforceFetch } from "./instrumentedFetch";

export interface HttpClientOptions {
	base: string;
	headers?: Record<string, string> | Headers;
	fetcher?: typeof fetch;
}

interface IndexedRouteResponse {
	json: <T = unknown>() => Promise<T>;
	ok: boolean;
	status: number;
	headers: Headers;
}

// Lazily-created, module-shared instrumented fetch used as the default
// transport. Every Salesforce loader instantiates its own `createHttpClient`
// inline, so defaulting the `fetcher` here is the single chokepoint that
// instruments ALL Salesforce egress (upstream latency/status → ClickHouse,
// `provider:"salesforce"`) without touching each loader. Sites that pass an
// explicit `fetcher` opt out; wrap it with `createSalesforceFetch({ baseFetch })`
// to keep instrumentation.
let _defaultFetch: typeof fetch | undefined;
function defaultInstrumentedFetch(): typeof fetch {
	if (!_defaultFetch) _defaultFetch = createSalesforceFetch();
	return _defaultFetch;
}

export function createHttpClient<_Routes = unknown>(options: HttpClientOptions) {
	const base = options.base.replace(/\/$/, "");
	const fetchImpl = options.fetcher ?? defaultInstrumentedFetch();
	const defaultHeaders: Record<string, string> =
		options.headers instanceof Headers
			? Object.fromEntries(options.headers.entries())
			: (options.headers ?? {});

	const handler: ProxyHandler<Record<string, unknown>> = {
		get(_target, prop) {
			if (prop === "get") {
				return async <R = unknown>(path: string, init?: RequestInit): Promise<R> => {
					const res = await fetchImpl(`${base}${path}`, {
						...init,
						headers: {
							...defaultHeaders,
							...((init?.headers as Record<string, string>) ?? {}),
						},
					});
					return res.json() as Promise<R>;
				};
			}
			if (prop === "post") {
				return async <R = unknown>(path: string, body: unknown, init?: RequestInit): Promise<R> => {
					const res = await fetchImpl(`${base}${path}`, {
						method: "POST",
						...init,
						headers: {
							"Content-Type": "application/json",
							...defaultHeaders,
							...((init?.headers as Record<string, string>) ?? {}),
						},
						body: JSON.stringify(body),
					});
					return res.json() as Promise<R>;
				};
			}
			if (typeof prop === "string" && /^(GET|POST|PUT|PATCH|DELETE)\s+/.test(prop)) {
				const spaceIdx = prop.indexOf(" ");
				const method = prop.slice(0, spaceIdx);
				let apiPath = prop.slice(spaceIdx + 1);

				return async (
					params: Record<string, unknown> = {},
					init?: RequestInit & { body?: unknown },
				): Promise<IndexedRouteResponse> => {
					const cleanParams = { ...params };

					// `:name` path placeholders — replaced with the matching
					// param value, then removed from the body/query object.
					for (const [key, value] of Object.entries(cleanParams)) {
						const placeholder = `:${key}`;
						if (apiPath.includes(placeholder) && value != null) {
							apiPath = apiPath.replace(placeholder, encodeURIComponent(String(value)));
							delete cleanParams[key];
						}
					}

					// Legacy `*name` placeholders (Deno-era convention).
					const starMatch = apiPath.match(/\*(\w+)/);
					if (starMatch) {
						const paramName = starMatch[1];
						if (cleanParams[paramName] != null) {
							apiPath = apiPath.replace(`*${paramName}`, String(cleanParams[paramName]));
							delete cleanParams[paramName];
						} else {
							apiPath = apiPath.replace(/\/\*\w+/, "");
						}
					}

					let url = `${base}${apiPath}`;

					if (method === "GET") {
						const sp = new URLSearchParams();
						for (const [k, v] of Object.entries(cleanParams)) {
							if (v !== undefined && v !== null) sp.set(k, String(v));
						}
						const qs = sp.toString();
						if (qs) url += (url.includes("?") ? "&" : "?") + qs;
					}

					// Indexed-route callers can either embed the body in the
					// remaining params (legacy style) OR pass `{ body }` in the
					// second arg (newer call sites). The `body` key in init
					// takes precedence when present.
					const explicitBody = init && "body" in init ? init.body : undefined;
					const fetchBody =
						method === "GET"
							? undefined
							: explicitBody !== undefined
								? JSON.stringify(explicitBody)
								: Object.keys(cleanParams).length > 0
									? JSON.stringify(cleanParams)
									: undefined;

					const fetchInit: RequestInit = {
						method,
						...(init ?? {}),
						headers: {
							"Content-Type": "application/json",
							...defaultHeaders,
							...(init?.headers instanceof Headers
								? Object.fromEntries(init.headers.entries())
								: ((init?.headers as Record<string, string>) ?? {})),
						},
						...(fetchBody !== undefined ? { body: fetchBody } : {}),
					};

					const res = await fetchImpl(url, fetchInit);
					return {
						json: <T = unknown>() => res.json() as Promise<T>,
						ok: res.ok,
						status: res.status,
						headers: res.headers,
					};
				};
			}
			return undefined;
		},
	};

	return new Proxy({} as Record<string, unknown>, handler) as Record<string, any>;
}
