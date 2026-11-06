/**
 * Request-time lookup for KV-keyed exact redirects.
 *
 * A bulk-migration site can carry tens of thousands of rules. Inside the
 * decofile they are resident in every isolate twice — the parsed snapshot graph
 * and the `RedirectMap` built from it — for data consulted at most once per
 * request and usually matching nothing. `splitExactRedirects` moves them to one
 * `redirect:<deployment-id>:<path>` key each at sync time, so the list is never
 * loaded and this looks up only the path actually being requested.
 *
 * Globs stay in the decofile and in memory: they must be scanned in order
 * against the path, so they can never be a key lookup. There are tens of them.
 *
 * Inert unless fast-deploy is on — without a `DECO_KV` binding there is nowhere
 * to look, and the rules are still in the decofile where `matchRedirect` finds
 * them. Same on-or-off switch as the rest of fast-deploy, so a site can't end
 * up with redirects in neither place.
 *
 * Two caches sit in front of KV's central store: the isolate memo below (60s)
 * and the Cloudflare location that made the read (KV's `cacheTtl`, 60s unless
 * the site sets `redirects.kvCacheTtl`). Both hold a miss as well as a hit, and
 * the location cache is shared by every isolate there, so a longer `cacheTtl`
 * is what turns the memo's once-a-minute re-read into a hot read. Neither can
 * be long by default: `redirect:<id>:<path>` is per CODE deployment, and a
 * content-only fast deploy rewrites it in place under the live id.
 */

import {
  getDeploymentId,
  type KVNamespace,
  redirectKey,
  type StoredRedirect,
} from "@decocms/blocks/cms";
import { normalizePath, type Redirect, selectExactRedirect } from "@decocms/blocks/sdk/redirects";
import { getFastDeployKV } from "./kvHydration";

/**
 * How long a lookup (hit OR miss) is trusted inside one isolate.
 *
 * Deliberately a TTL rather than the decofile revision: the rules now live in
 * their own keys, so a redirect-only content sync leaves the decofile byte
 * identical and the revision poller sees nothing to react to. The TTL is the
 * propagation delay for a redirect edit.
 *
 * Ceiling: if that delay ever needs to be near-zero, the upgrade is a
 * `index:redirects-revision:<id>` key polled next to `index:revision:<id>` —
 * not a shorter TTL, which just multiplies KV reads.
 */
const TTL_MS = 60_000;

/** Bounded so a crawler walking unique URLs cannot grow the isolate unbounded —
 *  the whole point of this module is to stop holding an unbounded list. */
const MAX_ENTRIES = 2_000;

/** KV refuses a `cacheTtl` below this (seconds). */
const MIN_KV_CACHE_TTL_S = 30;

/**
 * A `cacheTtl` KV accepts — an integer of at least 30 — or `undefined` to keep
 * KV's default (60s). KV rejects anything else, and `read` would turn that
 * rejection into "no redirect" on every request, so a bad value is ignored or
 * raised instead of reaching KV.
 */
function kvCacheTtl(seconds: number | undefined): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.max(MIN_KV_CACHE_TTL_S, Math.floor(seconds));
}

type StoredValue = StoredRedirect | StoredRedirect[];

interface CacheEntry {
  value: StoredValue | null;
  expiresAt: number;
}

// globalThis-backed so every Vite server-function split-module copy shares one
// cache (same reason as `loader.ts` and `kvHydration.ts`).
const G = globalThis as unknown as { __decoRedirectCache?: Map<string, CacheEntry> };
function cache(): Map<string, CacheEntry> {
  G.__decoRedirectCache ??= new Map();
  return G.__decoRedirectCache;
}

/** Insertion-ordered LRU touch + evict. */
function remember(key: string, value: StoredValue | null): void {
  const c = cache();
  c.delete(key);
  c.set(key, { value, expiresAt: Date.now() + TTL_MS });
  while (c.size > MAX_ENTRIES) c.delete(c.keys().next().value!);
}

/** Cached entry, or `undefined` when absent/expired. */
function peek(key: string): CacheEntry | undefined {
  const c = cache();
  const entry = c.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    c.delete(key);
    return undefined;
  }
  c.delete(key);
  c.set(key, entry);
  return entry;
}

/** Test seam — the cache is process-global, so suites must be able to reset it. */
export function clearRedirectCache(): void {
  G.__decoRedirectCache = new Map();
}

/**
 * Look up one exact redirect for the request's `pathname`. The key is
 * `normalizePath(pathname)` (the key contract, the same in both semantics);
 * which of the rules stored there answers — if any — is the semantics' call
 * (`selectExactRedirect`).
 *
 * Returns `null` for "no redirect", including every case where the lookup
 * cannot run (fast-deploy off, no deployment id, KV error). A KV failure must
 * not 5xx a page that would otherwise render: the worst outcome is the request
 * proceeds and the URL serves its normal response.
 *
 * Only navigations (GET/HEAD) read KV. A content redirect is a navigation
 * concept, and the rest of the traffic — the commerce proxy's cart/checkout
 * POSTs above all — has a fresh path per request (`/orderForm/<id>/…`), so the
 * isolate memo never hits and every one paid a serial KV miss (p75 ~160ms on
 * a production storefront) before reaching its handler. In-memory rules
 * (exact and glob) still apply to every method; only the KV read is gated.
 *
 * Trade-off: a temporary rule is served as 307, which browsers follow with the
 * original method, so a KV-only 307 on a form/webhook path used to forward the
 * POST and now lets it reach that path's handler. On a non-fast-deploy site
 * the same rule is in memory and still redirects POSTs — the behaviour differs
 * by deploy mode for that one case. Content redirects are navigation-only in
 * practice; a site that redirects POST endpoints should do it in code.
 *
 * `options.cacheTtl` is the KV read's `cacheTtl` in seconds (see the module
 * comment): unset keeps KV's 60s; below 30 is raised to 30, fractions are
 * dropped, and anything that is not a positive number is ignored.
 */
export async function lookupExactRedirect(
  env: Record<string, unknown>,
  pathname: string,
  method = "GET",
  options: { cacheTtl?: number } = {},
): Promise<Redirect | null> {
  if (method !== "GET" && method !== "HEAD") return null;
  const kv = getFastDeployKV(env);
  if (!kv) return null;

  const deploymentId = getDeploymentId(env);
  if (!deploymentId) return null;

  const key = redirectKey(deploymentId, normalizePath(pathname));
  const cached = peek(key);
  const stored =
    cached !== undefined ? cached.value : await read(kv, key, kvCacheTtl(options.cacheTtl));
  if (cached === undefined) remember(key, stored);
  if (!stored) return null;

  return selectExactRedirect(stored, pathname);
}

async function read(
  kv: Pick<KVNamespace, "get">,
  key: string,
  cacheTtl: number | undefined,
): Promise<StoredValue | null> {
  try {
    // No options object without a TTL: the read is exactly KV's default one.
    const raw = await (cacheTtl === undefined ? kv.get(key) : kv.get(key, { cacheTtl }));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    // A malformed value is a miss, not a throw — never let bad data in one key
    // take down every request for that path.
    const rules = (Array.isArray(parsed) ? parsed : [parsed])
      .map(toStored)
      .filter((r): r is StoredRedirect => r !== null);
    if (rules.length === 0) return null;
    return rules.length === 1 ? rules[0] : rules;
  } catch {
    return null;
  }
}

function toStored(value: unknown): StoredRedirect | null {
  const parsed = value as Partial<StoredRedirect> | null;
  if (!parsed || typeof parsed !== "object" || typeof parsed.to !== "string") return null;
  const stored: StoredRedirect = { to: parsed.to, status: parsed.status === 301 ? 301 : 307 };
  if (typeof parsed.from === "string") stored.from = parsed.from;
  if (parsed.discardQueryParameters === true) stored.discardQueryParameters = true;
  return stored;
}
