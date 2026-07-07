/**
 * Templates for src/lib/ utility wrappers that bridge signature gaps
 * between deco-cx/apps (old stack) and @decocms/apps-start (new stack).
 *
 * These are written *lazily*: only shims that are actually imported by
 * the migrated codebase get generated. See `selectImportedLibTemplates`.
 *
 * Lazy generation matters because:
 * - Most sites end up importing zero of these (apps-start exports
 *   direct equivalents for most VTEX utilities — see migrate#107).
 * - Eager generation creates dead `src/lib/*.ts` files that every site
 *   then has to clean up by hand (see baggagio-tanstack#7, ~235 LOC).
 *
 * Registry shape: `"src/lib/<name>.ts"` → file contents.
 */
export const LIB_TEMPLATES: Record<string, string> = {
  // Filled in below after the const declarations to keep the registry
  // and template literals colocated. See trailing assignment.
};

/**
 * Given the set of `~/lib/X` imports actually present in the migrated
 * codebase, return the subset of templates to write.
 *
 * `importedSpecifiers` are the `X` parts (without `~/lib/` prefix and
 * without `.ts` extension), e.g. `"vtex-transform"`, `"http-utils"`.
 */
export function selectImportedLibTemplates(
  importedSpecifiers: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of importedSpecifiers) {
    const key = `src/lib/${spec}.ts`;
    if (key in LIB_TEMPLATES) {
      out[key] = LIB_TEMPLATES[key];
    }
  }
  return out;
}

// Per the migration tooling policy (D3 — Throwing stubs):
// generated stubs MUST throw at runtime so the first call surfaces the
// gap loudly. Silent identity-cast `toProduct` was the bug behind
// baggagio-tanstack#10 (PDP product data was being dropped on the floor
// for weeks before anyone noticed).
//
// Each thrown message points at the canonical replacement so the fix
// is mechanical. `deco-post-cleanup --fix` automates the swap.
const LIB_VTEX_TRANSFORM = `import type { Product } from "@decocms/apps/commerce/types";

const STUB =
  "[deco-migrate] \`~/lib/vtex-transform.toProduct\` is a generated stub. " +
  "Replace with: import { toProduct } from '@decocms/apps/vtex/utils/transform' " +
  "(canonical signature: \`toProduct(product, sku, level, options)\`). " +
  "Run \`deco-post-cleanup --fix\` or see the deco-to-tanstack-migration skill " +
  "(post-migration-cleanup § 5).";

export function toProduct(_vtexProduct: any, ..._rest: any[]): Product {
  throw new Error(STUB);
}
`;

const LIB_VTEX_INTELLIGENT_SEARCH = `// Per the migration tooling policy (D3): \`getISCookiesFromBag\` cannot
// be implemented on TanStack Start because the bag-based lookup
// mechanism does not exist. Sites must read cookies directly from the
// request — see the \`vtex-shim-regression\` audit rule for guidance.
const STUB_GET_IS_COOKIES =
  "[deco-migrate] \`~/lib/vtex-intelligent-search.getISCookiesFromBag\` is a " +
  "generated stub. Refactor: extract IS cookies from " +
  "\`request.headers.get('cookie')\` directly. The bag-based lookup mechanism " +
  "does not exist on TanStack Start. See the deco-to-tanstack-migration " +
  "skill (post-migration-cleanup § 5).";

export function getISCookiesFromBag(_req?: any): Record<string, string> {
  throw new Error(STUB_GET_IS_COOKIES);
}

export function isFilterParam(key: string): boolean {
  return key.startsWith("filter.");
}

export function toPath(facets: { key: string; value: string }[]): string {
  return facets.map((f) => \`\${f.key}/\${f.value}\`).join("/");
}

export function withDefaultFacets(
  facets: { key: string; value: string }[],
  defaults?: any,
): { key: string; value: string }[] {
  if (Array.isArray(defaults)) {
    return [...defaults, ...facets];
  }
  return [...facets];
}

export function withDefaultParams(
  params: any,
  defaults?: Record<string, string>,
): any {
  if (params instanceof URLSearchParams) {
    if (defaults) {
      for (const [key, value] of Object.entries(defaults)) {
        if (!params.has(key)) {
          params.set(key, value);
        }
      }
    }
    return params;
  }
  return { ...params, ...defaults };
}
`;

const LIB_VTEX_SEGMENT = `// Per the migration tooling policy (D3): both these stubs throw at
// runtime to force the call site to be fixed. Silent fallbacks here
// mean the storefront silently fails to forward VTEX segment data
// (sales channel, regionId, currency, etc.) and pricing/inventory
// quietly diverge from what the user should see.
const STUB_GET_SEGMENT_FROM_BAG =
  "[deco-migrate] \`~/lib/vtex-segment.getSegmentFromBag\` is a generated " +
  "stub. Refactor: read cookies via \`request.headers.get('cookie')\` then " +
  "call \`buildSegmentFromCookies()\` from '@decocms/apps/vtex/utils/segment'. " +
  "The bag-based lookup mechanism does not exist on TanStack Start.";

const STUB_WITH_SEGMENT_COOKIE =
  "[deco-migrate] \`~/lib/vtex-segment.withSegmentCookie\` is a generated " +
  "stub. Replace with: import { withSegmentCookie } from " +
  "'@decocms/apps/vtex/utils/segment' (canonical signature: " +
  "\`withSegmentCookie(segment, headers?)\`). Run \`deco-post-cleanup --fix\` " +
  "or see the deco-to-tanstack-migration skill.";

export function getSegmentFromBag(_req?: any): Record<string, unknown> | null {
  throw new Error(STUB_GET_SEGMENT_FROM_BAG);
}

export function withSegmentCookie(..._args: any[]): any {
  throw new Error(STUB_WITH_SEGMENT_COOKIE);
}
`;

const LIB_HTTP_UTILS = `/**
 * Drop-in replacement for the typed HTTP client from deco-cx/apps.
 * Supports both simple \`.get(path)\` / \`.post(path, body)\` calls AND
 * the indexed pattern \`client["GET /api/path"]({params}, {init})\`
 * used by legacy loaders.
 */
export function createHttpClient<_T = any>(options: {
  base: string;
  headers?: Record<string, string> | Headers;
  fetcher?: typeof fetch;
}) {
  const base = options.base.replace(/\\/$/, "");
  const defaultHeaders: Record<string, string> =
    options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : (options.headers || {});

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === "get") {
        return async <R = any>(path: string, init?: RequestInit): Promise<R> => {
          const res = await fetch(\`\${base}\${path}\`, {
            ...init,
            headers: { ...defaultHeaders, ...(init?.headers as Record<string, string>) },
          });
          return res.json();
        };
      }
      if (prop === "post") {
        return async <R = any>(path: string, body: unknown, init?: RequestInit): Promise<R> => {
          const res = await fetch(\`\${base}\${path}\`, {
            method: "POST",
            ...init,
            headers: {
              "Content-Type": "application/json",
              ...defaultHeaders,
              ...(init?.headers as Record<string, string>),
            },
            body: JSON.stringify(body),
          });
          return res.json();
        };
      }
      if (typeof prop === "string" && /^(GET|POST|PUT|PATCH|DELETE)\\s+/.test(prop)) {
        const spaceIdx = prop.indexOf(" ");
        const method = prop.slice(0, spaceIdx);
        let apiPath = prop.slice(spaceIdx + 1);

        return async (params: Record<string, any> = {}, init?: RequestInit) => {
          const cleanParams = { ...params };

          const starMatch = apiPath.match(/\\*(\\w+)/);
          if (starMatch) {
            const paramName = starMatch[1];
            if (cleanParams[paramName] != null) {
              apiPath = apiPath.replace(\`*\${paramName}\`, String(cleanParams[paramName]));
              delete cleanParams[paramName];
            } else {
              apiPath = apiPath.replace(/\\/\\*\\w+/, "");
            }
          }

          let url = \`\${base}\${apiPath}\`;

          if (method === "GET") {
            const sp = new URLSearchParams();
            for (const [k, v] of Object.entries(cleanParams)) {
              if (v !== undefined && v !== null) sp.set(k, String(v));
            }
            const qs = sp.toString();
            if (qs) url += (url.includes("?") ? "&" : "?") + qs;
          }

          const fetchInit: RequestInit = {
            method,
            ...init,
            headers: {
              ...defaultHeaders,
              ...(init?.headers instanceof Headers
                ? Object.fromEntries(init.headers.entries())
                : (init?.headers as Record<string, string>)),
            },
            ...(method !== "GET" && Object.keys(cleanParams).length > 0
              ? { body: JSON.stringify(cleanParams) }
              : {}),
          };

          const res = await fetch(url, fetchInit);
          return { json: () => res.json(), ok: res.ok, status: res.status, headers: res.headers };
        };
      }
      return undefined;
    },
  };

  return new Proxy({} as Record<string, unknown>, handler) as any;
}
`;

const LIB_VTEX_CLIENT = `export interface VTEXCommerceStable {
  account: string;
  environment?: string;
}
`;

const LIB_FETCH_UTILS = `export const STALE = {
  "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
};
`;

const LIB_VTEX_FETCH = `export async function fetchSafe(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    console.error(\`VTEX fetch failed: \${response.status} \${response.statusText}\`);
  }
  return response;
}
`;

const LIB_VTEX_ID = `export function parseCookie(cookieStr?: string | null): Record<string, string> {
  if (!cookieStr) return {};
  return Object.fromEntries(
    cookieStr.split(";").map((c) => {
      const [key, ...rest] = c.trim().split("=");
      return [key, rest.join("=")];
    }),
  );
}
`;

const LIB_GRAPHQL_UTILS = `export function createGraphqlClient(options: {
  endpoint: string;
  headers?: Record<string, string>;
}) {
  return {
    async query<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const res = await fetch(options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      return json.data;
    },
  };
}
`;

const LIB_FILTER_NAVIGATE = `/**
 * Converts a VTEX filter URL string (e.g. "?filter.brand=x&filter.price=10:50")
 * into a clean search string without internal params like \`payload\`.
 * Returns "" or "?filter.brand=x&..." ready to append to pathname.
 */
export function toFilterSearchString(filterUrl: string): string {
  const str = filterUrl.startsWith("?") ? filterUrl.slice(1) : filterUrl;
  if (!str) return "";

  const params = new URLSearchParams(str);
  params.delete("payload");

  const clean = params.toString();
  return clean ? \`?\${clean}\` : "";
}
`;

// Populate the registry now that all template literals are declared.
// Keys must match the relative path the migration script writes; values
// are the file contents.
Object.assign(LIB_TEMPLATES, {
  "src/lib/vtex-transform.ts": LIB_VTEX_TRANSFORM,
  "src/lib/vtex-intelligent-search.ts": LIB_VTEX_INTELLIGENT_SEARCH,
  "src/lib/vtex-segment.ts": LIB_VTEX_SEGMENT,
  "src/lib/http-utils.ts": LIB_HTTP_UTILS,
  "src/lib/vtex-client.ts": LIB_VTEX_CLIENT,
  "src/lib/fetch-utils.ts": LIB_FETCH_UTILS,
  "src/lib/vtex-fetch.ts": LIB_VTEX_FETCH,
  "src/lib/vtex-id.ts": LIB_VTEX_ID,
  "src/lib/graphql-utils.ts": LIB_GRAPHQL_UTILS,
  "src/lib/filter-navigate.ts": LIB_FILTER_NAVIGATE,
});
