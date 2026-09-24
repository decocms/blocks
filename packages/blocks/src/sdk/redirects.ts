/**
 * CMS-managed redirect system.
 *
 * Loads redirect definitions from .deco/blocks/ and provides
 * fast path matching for use in TanStack Start middleware.
 *
 * Supports:
 * - Exact path matches (/old-page -> /new-page)
 * - Glob patterns (/old/* -> /new/*)
 * - Permanent (301) and temporary (302) redirects
 * - CSV import for bulk redirects
 *
 * @example
 * ```ts
 * // In TanStack Start middleware
 * import { loadRedirects, matchRedirect } from "@decocms/start/sdk/redirects";
 * import { loadBlocks } from "@decocms/start/cms";
 *
 * const redirects = loadRedirects(loadBlocks());
 *
 * const middleware = createMiddleware().server(async ({ next, request }) => {
 *   const url = new URL(request.url);
 *   const redirect = matchRedirect(url.pathname, redirects);
 *   if (redirect) {
 *     return new Response(null, {
 *       status: redirect.status,
 *       headers: { Location: redirect.to },
 *     });
 *   }
 *   return next();
 * });
 * ```
 */

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface Redirect {
  from: string;
  to: string;
  status: 301 | 302;
}

export interface RedirectMap {
  /** Exact match redirects for O(1) lookup. */
  exact: Map<string, Redirect>;
  /** Glob/prefix redirects checked sequentially (few in practice). */
  patterns: Array<{ prefix: string; redirect: Redirect }>;
}

// -------------------------------------------------------------------------
// Loading from CMS blocks
// -------------------------------------------------------------------------

interface BlockRedirectEntry {
  from: string;
  to: string;
  type?: "permanent" | "temporary";
}

const REDIRECT_RESOLVE_TYPES = new Set([
  "website/loaders/redirect.ts",
  "website/loaders/redirects.ts",
  "website/loaders/redirectsFromCsv.ts",
  "deco-sites/std/loaders/x/redirects.ts",
]);

/**
 * Register additional __resolveType strings that should be treated as redirect blocks.
 * Useful for custom redirect loaders.
 */
export function registerRedirectResolveType(resolveType: string): void {
  REDIRECT_RESOLVE_TYPES.add(resolveType);
}

/**
 * Load all redirect definitions from CMS blocks.
 *
 * Scans the blocks for known redirect resolve types and builds
 * a fast-lookup redirect map.
 */
export function loadRedirects(blocks: Record<string, unknown>): RedirectMap {
  const exact = new Map<string, Redirect>();
  const patterns: Array<{ prefix: string; redirect: Redirect }> = [];

  for (const [_key, block] of Object.entries(blocks)) {
    if (!block || typeof block !== "object") continue;
    const obj = block as Record<string, unknown>;
    const resolveType = obj.__resolveType as string | undefined;

    if (!resolveType || !REDIRECT_RESOLVE_TYPES.has(resolveType)) continue;

    const entries = (obj.redirects ?? obj.redirect) as
      | BlockRedirectEntry[]
      | BlockRedirectEntry
      | undefined;

    if (!entries) continue;

    const list = Array.isArray(entries) ? entries : [entries];

    for (const entry of list) {
      if (!entry.from || !entry.to) continue;

      const redirect: Redirect = {
        from: normalizePath(entry.from),
        to: entry.to,
        status: entry.type === "permanent" ? 301 : 302,
      };

      if (redirect.from.includes("*")) {
        const prefix = redirect.from.replace(/\*+$/, "");
        patterns.push({ prefix, redirect });
      } else {
        exact.set(redirect.from, redirect);
      }
    }
  }

  return { exact, patterns };
}

// -------------------------------------------------------------------------
// CSV import
// -------------------------------------------------------------------------

/**
 * Parse a CSV string into redirect entries.
 *
 * Expected format: `from,to[,type]` (one per line).
 * Lines starting with # are comments. Empty lines are skipped.
 * Type is "permanent" (301) or "temporary" (302, default).
 */
export function parseRedirectsCsv(csv: string): Redirect[] {
  const redirects: Redirect[] = [];
  const lines = csv.split("\n");

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2) continue;

    const [from, to, type] = parts;
    if (!from || !to) continue;
    // Skip a header row (`from,to[,type]`). Robust for CSVs with or without a
    // header, and for a header repeated when multiple files are concatenated.
    if (from.toLowerCase() === "from" && to.toLowerCase() === "to") continue;

    redirects.push({
      from: normalizePath(from),
      to,
      status: type === "permanent" || type === "301" ? 301 : 302,
    });
  }

  return redirects;
}

/**
 * Add parsed redirects to an existing redirect map.
 */
export function addRedirects(map: RedirectMap, redirects: Redirect[]): void {
  for (const redirect of redirects) {
    if (redirect.from.includes("*")) {
      const prefix = redirect.from.replace(/\*+$/, "");
      map.patterns.push({ prefix, redirect });
    } else {
      map.exact.set(redirect.from, redirect);
    }
  }
}

// -------------------------------------------------------------------------
// Matching
// -------------------------------------------------------------------------

/**
 * Find a redirect matching the given path.
 *
 * Checks exact matches first (O(1)), then glob patterns (O(n), but
 * typically few patterns exist).
 */
export function matchRedirect(pathname: string, map: RedirectMap): Redirect | null {
  return matchExactRedirect(pathname, map) ?? matchPatternRedirect(pathname, map);
}

/**
 * Exact half of `matchRedirect`. Split out because the KV-keyed path has to
 * interleave a third source between the two halves: in-memory exact, then the
 * `redirect:<id>:<path>` KV lookup, then patterns. Collapsing that to
 * "matchRedirect, then KV" would let a glob win over an exact rule, inverting
 * the precedence every other path has.
 */
export function matchExactRedirect(pathname: string, map: RedirectMap): Redirect | null {
  return map.exact.get(normalizePath(pathname)) ?? null;
}

/** Pattern half of `matchRedirect` — ordered prefix scan, `*` suffix carried over. */
export function matchPatternRedirect(pathname: string, map: RedirectMap): Redirect | null {
  const normalized = normalizePath(pathname);
  for (const { prefix, redirect } of map.patterns) {
    if (normalized.startsWith(prefix)) {
      const suffix = normalized.slice(prefix.length);
      const to = redirect.to.includes("*") ? redirect.to.replace("*", suffix) : redirect.to;
      return { ...redirect, to };
    }
  }
  return null;
}

// -------------------------------------------------------------------------
// Splitting exact rules out of the decofile (KV-keyed redirects)
// -------------------------------------------------------------------------

/** One exact rule, ready to be written to its own KV key. */
export interface ExactRedirect {
  /** Normalized path — the KV key suffix. */
  path: string;
  to: string;
  status: 301 | 302;
}

export interface SplitRedirectsResult {
  /** The blocks map with every EXACT rule removed. Glob rules stay (they can't
   *  be addressed by key), and a redirect block left with no entries at all is
   *  dropped entirely rather than left as an empty husk. */
  blocks: Record<string, unknown>;
  /** The extracted exact rules, deduped by path (last wins, matching
   *  `loadRedirects`, which is last-write-wins over insertion order). */
  exact: ExactRedirect[];
}

/**
 * Split a decofile into "blocks without exact redirects" + "the exact rules".
 *
 * A bulk-migration site can carry tens of thousands of rules. Left inside the
 * decofile they sit in every isolate twice — the parsed snapshot graph and the
 * `RedirectMap` built from it — for data that is consulted at most once per
 * request and usually matches nothing. Moved to one KV key each, the list is
 * never loaded.
 *
 * Read-only over `blocks`: the returned map shares every untouched value and
 * only clones the redirect blocks it had to rewrite.
 */
export function splitExactRedirects(blocks: Record<string, unknown>): SplitRedirectsResult {
  const exact = new Map<string, ExactRedirect>();
  const out: Record<string, unknown> = {};

  for (const [key, block] of Object.entries(blocks)) {
    const obj = block && typeof block === "object" ? (block as Record<string, unknown>) : null;
    const resolveType = obj?.__resolveType as string | undefined;
    if (!obj || !resolveType || !REDIRECT_RESOLVE_TYPES.has(resolveType)) {
      out[key] = block;
      continue;
    }

    const raw = (obj.redirects ?? obj.redirect) as
      | BlockRedirectEntry[]
      | BlockRedirectEntry
      | undefined;
    if (!raw) {
      out[key] = block;
      continue;
    }

    const kept: BlockRedirectEntry[] = [];
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      if (!entry?.from || !entry.to) continue;
      const from = normalizePath(entry.from);
      // Globs must be scanned in order against the request path, so they can
      // never be a key lookup — they stay in the decofile.
      if (from.includes("*")) {
        kept.push(entry);
        continue;
      }
      exact.set(from, {
        path: from,
        to: entry.to,
        status: entry.type === "permanent" ? 301 : 302,
      });
    }

    // Nothing left to scan ⇒ drop the block rather than ship an empty husk.
    if (kept.length === 0) continue;
    // Rebuild without `redirect` — a block may have carried the singular form,
    // and leaving it would reintroduce the rule we just extracted.
    const { redirect: _dropped, ...rest } = obj;
    out[key] = { ...rest, redirects: kept };
  }

  return { blocks: out, exact: [...exact.values()] };
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Canonical redirect-path form: origin stripped, leading slash forced, trailing
 * slash dropped, lower-cased.
 *
 * Exported because it is the KV key contract for `redirect:<id>:<path>` — the
 * sync script that WRITES the keys and the worker that READS them must agree
 * byte for byte, or a rule is stored under a key nothing ever asks for. Never
 * inline a different normalization on either side.
 */
export function normalizePath(path: string): string {
  let p = path.trim();

  // If the "from" is a full URL, extract just the pathname
  if (p.startsWith("http://") || p.startsWith("https://")) {
    try {
      p = new URL(p).pathname;
    } catch {
      // malformed URL, keep as-is and try the prefix fallback
      const slashIdx = p.indexOf("/", p.indexOf("//") + 2);
      p = slashIdx >= 0 ? p.slice(slashIdx) : p;
    }
  }

  if (!p.startsWith("/")) {
    p = "/" + p;
  }
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p.toLowerCase();
}
