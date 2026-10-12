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
 */

import { getDeploymentId, redirectKey, type StoredRedirect } from "@decocms/blocks/cms";
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
 */
export async function lookupExactRedirect(
  env: Record<string, unknown>,
  pathname: string,
): Promise<Redirect | null> {
  const kv = getFastDeployKV(env);
  if (!kv) return null;

  const deploymentId = getDeploymentId(env);
  if (!deploymentId) return null;

  const key = redirectKey(deploymentId, normalizePath(pathname));
  const cached = peek(key);
  const stored = cached !== undefined ? cached.value : await read(kv, key);
  if (cached === undefined) remember(key, stored);
  if (!stored) return null;

  return selectExactRedirect(stored, pathname);
}

async function read(
  kv: { get(key: string): Promise<string | null> },
  key: string,
): Promise<StoredValue | null> {
  try {
    const raw = await kv.get(key);
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
