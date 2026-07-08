/**
 * Minimal Cloudflare KV REST API client for CI.
 *
 * CI has no Worker KV binding, so the fast-deploy sync/migrate scripts write to
 * KV over the REST API instead. Only the two operations the scripts need —
 * single-key GET and PUT — are implemented.
 *
 * Auth/config resolution (read by the scripts, passed to `createKvRestClient`),
 * each with a fallback so the scripts run near-zero-config inside Cloudflare
 * Workers Builds (whose build env already carries wrangler's standard
 * credentials, and whose checkout contains the wrangler config):
 *   - CF_ACCOUNT_ID       falls back to CLOUDFLARE_ACCOUNT_ID (wrangler standard)
 *   - CF_API_TOKEN        falls back to CLOUDFLARE_API_TOKEN (wrangler standard;
 *                         the default Workers Builds token includes
 *                         "Workers KV Storage: Edit")
 *   - CF_KV_NAMESPACE_ID  falls back to the `DECO_KV` binding id in the repo's
 *                         wrangler config (single source of truth with the
 *                         worker's read binding)
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
}

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Resolve the KV REST config from env, with wrangler-friendly fallbacks:
 * `CF_*` (explicit, e.g. set by the operator's sync Job) wins; otherwise
 * wrangler's standard `CLOUDFLARE_*` env vars (present in CF Workers Builds)
 * and the `DECO_KV` binding id from the wrangler config in `wranglerDir`.
 * Throws a clear error naming what's still missing.
 */
export function kvConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { wranglerDir?: string } = {},
): Omit<KvRestConfig, "fetchImpl" | "baseUrl"> {
  const accountId = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const namespaceId = env.CF_KV_NAMESPACE_ID ||
    (opts.wranglerDir ? kvNamespaceIdFromWrangler(opts.wranglerDir) : null);
  const missing = [
    !accountId && "CF_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)",
    !namespaceId && "CF_KV_NAMESPACE_ID (or a DECO_KV binding in wrangler config)",
    !token && "CF_API_TOKEN (or CLOUDFLARE_API_TOKEN)",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`missing required env var(s): ${missing.join(", ")}`);
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
  };
}
