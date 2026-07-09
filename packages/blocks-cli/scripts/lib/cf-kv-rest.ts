/**
 * Minimal Cloudflare KV REST API client for CI.
 *
 * CI has no Worker KV binding, so the fast-deploy sync/migrate scripts write to
 * KV over the REST API instead. Only the operations the scripts need — single-key
 * GET/PUT/DELETE plus prefix LIST (for per-deployment GC) — are implemented.
 *
 * Auth/config via env (read by the scripts, passed to `createKvRestClient`):
 *   - CF_ACCOUNT_ID       Cloudflare account id      (or CLOUDFLARE_ACCOUNT_ID)
 *   - CF_API_TOKEN        API token, "Workers KV Storage:Edit" (or CLOUDFLARE_API_TOKEN)
 *   - CF_KV_NAMESPACE_ID  target KV namespace id     (or read from wrangler config)
 *
 * The `CLOUDFLARE_*` fallbacks + wrangler-config namespace lookup make the sync
 * seamless inside Cloudflare Workers Builds, which injects `CLOUDFLARE_ACCOUNT_ID`
 * / `CLOUDFLARE_API_TOKEN` (the default build token has Workers KV: Edit) and
 * declares the namespace id in `wrangler.jsonc` — so no extra env wiring is
 * needed there. Explicit `CF_*` still wins (e.g. the operator's k8s sync Job).
 *
 * `fetch` is injectable so the client is unit-testable without network.
 */

import { kvNamespaceIdFromWrangler } from "./wrangler-config";

export interface KvRestConfig {
  accountId: string;
  namespaceId: string;
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override API base (tests). Defaults to the Cloudflare API. */
  baseUrl?: string;
}

export interface KvRestClient {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** List key names, optionally filtered by prefix. Follows pagination. */
  list(prefix?: string): Promise<string[]>;
}

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Resolve the required KV config or throw a clear error. Accepts the `CF_*`
 * names (explicit, win) or the `CLOUDFLARE_*` names CF Workers Builds injects.
 * When `CF_KV_NAMESPACE_ID` is unset and `opts.wranglerDir` is given, the
 * namespace id is read from that dir's wrangler config (`DECO_KV` binding).
 */
export function kvConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { wranglerDir?: string } = {},
): Omit<KvRestConfig, "fetchImpl" | "baseUrl"> {
  const accountId = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  let namespaceId = env.CF_KV_NAMESPACE_ID;
  if (!namespaceId && opts.wranglerDir) {
    namespaceId = kvNamespaceIdFromWrangler(opts.wranglerDir) ?? undefined;
  }
  const missing = [
    !accountId && "CF_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)",
    !namespaceId && "CF_KV_NAMESPACE_ID (or a DECO_KV binding in wrangler config)",
    !token && "CF_API_TOKEN (or CLOUDFLARE_API_TOKEN)",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`missing required KV config: ${missing.join(", ")}`);
  }
  return { accountId: accountId!, namespaceId: namespaceId!, token: token! };
}

export function createKvRestClient(config: KvRestConfig): KvRestClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = config.baseUrl ?? DEFAULT_BASE;
  const root = `${base}/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}`;
  const authHeaders = { Authorization: `Bearer ${config.token}` };

  return {
    async get(key) {
      const res = await fetchImpl(`${root}/values/${encodeURIComponent(key)}`, {
        headers: authHeaders,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`KV GET ${key} failed: ${res.status} ${await res.text()}`);
      }
      return res.text();
    },

    async put(key, value) {
      const res = await fetchImpl(`${root}/values/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "text/plain" },
        body: value,
      });
      if (!res.ok) {
        throw new Error(`KV PUT ${key} failed: ${res.status} ${await res.text()}`);
      }
    },

    async delete(key) {
      const res = await fetchImpl(`${root}/values/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      // 404 is fine — the key is already gone (idempotent delete).
      if (!res.ok && res.status !== 404) {
        throw new Error(`KV DELETE ${key} failed: ${res.status} ${await res.text()}`);
      }
    },

    async list(prefix) {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const qs = new URLSearchParams();
        if (prefix) qs.set("prefix", prefix);
        if (cursor) qs.set("cursor", cursor);
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        const res = await fetchImpl(`${root}/keys${suffix}`, { headers: authHeaders });
        if (!res.ok) {
          throw new Error(`KV LIST ${prefix ?? ""} failed: ${res.status} ${await res.text()}`);
        }
        const body = (await res.json()) as {
          result?: Array<{ name: string }>;
          result_info?: { cursor?: string };
        };
        for (const k of body.result ?? []) names.push(k.name);
        cursor = body.result_info?.cursor || undefined;
      } while (cursor);
      return names;
    },
  };
}
