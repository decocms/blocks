/**
 * CMS-managed redirect system.
 *
 * Loads redirect definitions from .deco/blocks/ and provides
 * fast path matching for use in TanStack Start middleware.
 *
 * Supports:
 * - Exact matches (/old-page -> /new-page), optionally scoped to a query
 *   (/old-page?map=ft -> /new-page)
 * - Glob patterns (/old/* -> /new/*)
 * - Permanent (301) and temporary (307) redirects
 * - CSV import for bulk redirects
 *
 * The semantics are those of the Fresh loaders and handlers this module
 * replaced (deco-cx/apps `website/loaders/redirectsFromCsv.ts`,
 * `website/loaders/redirects.ts`, `website/handlers/router.ts`,
 * `website/handlers/redirect.ts`), so a site migrated from Fresh answers the
 * same URL with the same status and `Location`:
 *
 * - a source matches the request's `pathname` (or `pathname + search`) byte
 *   for byte — no case folding, no trailing-slash folding. `/Calca-x/p` and
 *   `/calca-x/p` are two different rules, and a rule from `/Calca-x/p` to
 *   `/calca-x/p` is a redirect, not a loop;
 * - `type` is `permanent` (301) or anything else (307 — `PERMANENT` in capitals
 *   included, as in Fresh);
 * - the request's query string is appended to `Location` unless the rule sets
 *   `discardQueryParameters`, so campaign parameters survive the hop.
 *
 * Both: a rule whose source equals its target is dropped at load time (and, in
 * `"legacy"`, a rule that folding turns into a self-redirect — `/Calca/p` →
 * `/calca/p`), `Location` is never double-encoded (`%20` stays `%20`), a
 * query-scoped source (`/x?map=ft`) matches `pathname + search` before the bare
 * pathname, and the CSV is parsed like Fresh's (`,`/`;` split, `type` and
 * `discardQueryParameters` read by value).
 *
 * @example
 * ```ts
 * // In TanStack Start middleware
 * import { loadRedirects, matchRedirect, redirectLocation } from "@decocms/blocks/sdk/redirects";
 * import { loadBlocks } from "@decocms/blocks/cms";
 *
 * const redirects = loadRedirects(loadBlocks());
 *
 * const middleware = createMiddleware().server(async ({ next, request }) => {
 *   const url = new URL(request.url);
 *   const redirect = matchRedirect(url.pathname, redirects, url.search);
 *   if (redirect) {
 *     return new Response(null, {
 *       status: redirect.status,
 *       headers: { Location: redirectLocation(redirect, url.search) },
 *     });
 *   }
 *   return next();
 * });
 * ```
 */

// -------------------------------------------------------------------------
// Semantics
// -------------------------------------------------------------------------

/**
 * `"legacy"`: case- and trailing-slash-insensitive match, 302 for temporary,
 * query dropped. `"fresh"`: the Fresh handlers' byte-for-byte match, 307, query
 * kept. See the module doc.
 */
export type RedirectSemantics = "legacy" | "fresh";

// globalThis-backed so every Vite server-function split-module copy reads the
// same value (same reason as `kvRedirects.ts`'s cache).
const G = globalThis as unknown as { __decoRedirectSemantics?: RedirectSemantics };

/**
 * Choose the redirect semantics for this isolate. Call once at boot, before the
 * first `loadRedirects` — a map already built keeps the keys it was built with.
 * `createDecoWorkerEntry({ redirects: { semantics } })` does this for you.
 */
export function setRedirectSemantics(semantics: RedirectSemantics): void {
  G.__decoRedirectSemantics = semantics;
}

export function getRedirectSemantics(): RedirectSemantics {
  return G.__decoRedirectSemantics ?? "legacy";
}

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface Redirect {
  /**
   * Source as matched: the map key (`normalizePath` in `"legacy"`,
   * `sourcePath` in `"fresh"`), or that plus `?search` for a query-scoped rule.
   */
  from: string;
  to: string;
  /** 301 for `permanent`; temporary is 302 in `"legacy"`, 307 in `"fresh"`. */
  status: 301 | 302 | 307;
  /**
   * Answer with `to` as written instead of appending the request's query
   * string to it. Only present when true; only read in `"fresh"`.
   */
  discardQueryParameters?: boolean;
}

export interface RedirectMap {
  /** Exact match redirects for O(1) lookup, keyed by `Redirect.from`. */
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
  discardQueryParameters?: boolean;
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
 * a fast-lookup redirect map, keyed for the current `getRedirectSemantics()`.
 */
export function loadRedirects(blocks: Record<string, unknown>): RedirectMap {
  const map: RedirectMap = { exact: new Map(), patterns: [] };

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
      const redirect = toRedirect(entry);
      if (redirect) addToMap(map, redirect);
    }
  }

  return map;
}

// -------------------------------------------------------------------------
// CSV import
// -------------------------------------------------------------------------

export interface ParseRedirectsCsvOptions {
  /**
   * Rows without an explicit type are `permanent` (301) instead of
   * `temporary` — the `forcePermanentRedirects` prop of the Fresh
   * `redirectsFromCsv` loader.
   */
  forcePermanentRedirects?: boolean;
}

const REDIRECT_TYPE_VALUES = ["temporary", "permanent", "301"];
const DISCARD_QUERY_VALUES = ["true", "false"];

/** Fresh's field split, verbatim: a comma always splits; a semicolon only outside quotes. */
const CSV_FIELD_SPLIT = /,|;(?=(?:(?:[^"]*"){2})*[^"]*$)/;

/** Remove and return the first element of `array` that is one of `values`. */
function findAndRemove(array: string[], values: string[]): string | null {
  const index = array.findIndex((item) => values.includes(item));
  return index === -1 ? null : array.splice(index, 1)[0];
}

/**
 * Parse a CSV string into redirect entries.
 *
 * Expected format: `from,to[,type][,discardQueryParameters]` (one per line).
 * `type` and `discardQueryParameters` are recognized by value, in any column
 * after the first two: `type` is `permanent` (301) or `temporary` (the
 * default); `discardQueryParameters` is `true` or `false`. The comparison is
 * exact, as in Fresh — `PERMANENT` is not `permanent` and yields a temporary.
 *
 * `from` is returned as written — the map it is added to keys it for its
 * semantics.
 *
 * Lines starting with # are comments. Empty lines and the header row are
 * skipped. A row whose source equals its target is dropped.
 */
export function parseRedirectsCsv(csv: string, options: ParseRedirectsCsvOptions = {}): Redirect[] {
  const redirects: Redirect[] = [];
  const lines = csv.split(/\r\n|\r|\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(CSV_FIELD_SPLIT).map((p) => p.trim());
    const type =
      findAndRemove(parts, REDIRECT_TYPE_VALUES) ??
      (options.forcePermanentRedirects ? "permanent" : "temporary");
    const discardQueryParameters = findAndRemove(parts, DISCARD_QUERY_VALUES) === "true";

    const [from, to] = parts;
    if (!from || !to) continue;
    // Skip a header row (`from,to[,type]`). Robust for CSVs with or without a
    // header, and for a header repeated when multiple files are concatenated.
    if (from.toLowerCase() === "from" && to.toLowerCase() === "to") continue;

    const redirect = toRedirect({ from, to, type, discardQueryParameters });
    if (redirect) redirects.push(redirect);
  }

  return redirects;
}

/**
 * Add parsed redirects to an existing redirect map.
 */
export function addRedirects(map: RedirectMap, redirects: Redirect[]): void {
  for (const redirect of redirects) addToMap(map, redirect);
}

function addToMap(map: RedirectMap, redirect: Redirect): void {
  const from = matchKey(redirect.from);
  if (!from || loopsWhenFolded(from, redirect.to)) return;
  const keyed = from === redirect.from ? redirect : { ...redirect, from };
  if (from.includes("*")) {
    const prefix = from.replace(/\*+$/, "");
    map.patterns.push({ prefix, redirect: keyed });
  } else {
    // Later rules win, as in Fresh's route table.
    map.exact.set(from, keyed);
  }
}

/**
 * One rule from any source (CMS block entry or CSV row), or `null` when it
 * can't be a rule: missing a side, or a self-redirect (`from === to`, which
 * the Fresh loader also skipped and which would otherwise loop forever).
 * `from` is the source as written, not yet a map key.
 */
function toRedirect(entry: {
  from?: string;
  to?: string;
  type?: string;
  discardQueryParameters?: boolean;
}): Redirect | null {
  if (!entry.from || !entry.to) return null;
  // Kept as written: an absolute source keys differently per semantics
  // (`"legacy"` drops its query, `"fresh"` keeps it).
  const from = entry.from.trim();
  const to = entry.to.trim();
  if (!from || !to || sourcePath(from) === to) return null;

  const redirect: Redirect = { from, to, status: statusFor(isPermanent(entry.type)) };
  if (entry.discardQueryParameters) redirect.discardQueryParameters = true;
  return redirect;
}

function isPermanent(type: string | undefined): boolean {
  return type === "permanent" || type === "301";
}

/**
 * `permanent` → 301; anything else → 302 in `"legacy"`, 307 in `"fresh"`
 * (Fresh's `website/handlers/redirect.ts`).
 */
function statusFor(permanent: boolean): 301 | 302 | 307 {
  if (permanent) return 301;
  return getRedirectSemantics() === "fresh" ? 307 : 302;
}

/**
 * In `"legacy"` the match folds case and a trailing slash and ignores the
 * query, so a rule whose target folds back to its own key (`/Calca/p` →
 * `/calca/p`, `/x` → `/x?utm=1`) redirects to itself forever. Such a rule can
 * never be served, so it is dropped. Only same-site targets (`/…`) can loop.
 */
function loopsWhenFolded(key: string, to: string): boolean {
  if (getRedirectSemantics() !== "legacy") return false;
  if (!to.startsWith("/") || to.startsWith("//")) return false;
  return normalizePath(to.split(/[?#]/)[0]) === key;
}

// -------------------------------------------------------------------------
// Matching
// -------------------------------------------------------------------------

/**
 * Find a redirect matching the given path.
 *
 * Checks exact matches first (O(1)), then glob patterns (O(n), but
 * typically few patterns exist). Pass the request's `search` (`url.search`)
 * so a rule scoped to a query (`/x?map=ft`) can match: it is tried before the
 * bare pathname, as the more specific rule.
 */
export function matchRedirect(pathname: string, map: RedirectMap, search = ""): Redirect | null {
  return matchExactRedirect(pathname, map, search) ?? matchPatternRedirect(pathname, map);
}

/**
 * Exact half of `matchRedirect`. Split out because the KV-keyed path has to
 * interleave a third source between the two halves: in-memory exact, then the
 * `redirect:<id>:<path>` KV lookup, then patterns. Collapsing that to
 * "matchRedirect, then KV" would let a glob win over an exact rule, inverting
 * the precedence every other path has.
 *
 * `pathname + search` is looked up before `pathname`, as Fresh's router does
 * (`hrefRoutes[pathname + search] ?? hrefRoutes[pathname]`).
 */
export function matchExactRedirect(
  pathname: string,
  map: RedirectMap,
  search = "",
): Redirect | null {
  const path = matchKey(pathname);
  return (
    (search ? map.exact.get(matchKey(path + search)) : undefined) ?? map.exact.get(path) ?? null
  );
}

/** Pattern half of `matchRedirect` — ordered prefix scan, `*` suffix carried over. */
export function matchPatternRedirect(pathname: string, map: RedirectMap): Redirect | null {
  const path = matchKey(pathname);
  for (const { prefix, redirect } of map.patterns) {
    if (path.startsWith(prefix)) {
      const suffix = path.slice(prefix.length);
      const to = redirect.to.includes("*") ? redirect.to.replace("*", suffix) : redirect.to;
      return { ...redirect, to };
    }
  }
  return null;
}

/**
 * The `Location` header for a matched redirect.
 *
 * `"fresh"`: `to`, with the request's query string appended unless the rule
 * discards it (Fresh's `website/handlers/redirect.ts`). Campaign parameters
 * (`utm_*`, `gclid`) survive the hop that way. The query is appended sorted by
 * key, each pair kept as it came (`%20` stays `%20`) — the Fresh runtime handed
 * handlers a request whose query was already in that order, so
 * `?utm_source=qa&gclid=x` answered `?gclid=x&utm_source=qa`.
 *
 * `"legacy"`: `to` alone; the request's query is dropped.
 *
 * Both: `to` travels as written, except for characters a header cannot carry
 * (non-ASCII, spaces, controls), which are percent-encoded. An escape already
 * in `to` (`%20`) is left alone — `encodeURI` would turn it into `%2520`.
 */
export function redirectLocation(
  redirect: Pick<Redirect, "to" | "discardQueryParameters">,
  search = "",
): string {
  const to = encodeForHeader(redirect.to);
  if (getRedirectSemantics() !== "fresh" || redirect.discardQueryParameters) return to;
  const queryString = sortQueryByKey(search);
  if (!queryString) return to;
  return to.includes("?") ? `${to}&${queryString}` : `${to}?${queryString}`;
}

/** Stable sort of `a=1&b=2` pairs by key; pairs are not re-encoded. */
function sortQueryByKey(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return raw
    .split("&")
    .filter(Boolean)
    .map((pair, index) => ({ pair, index, key: pair.split("=")[0] }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map(({ pair }) => pair)
    .join("&");
}

function encodeForHeader(value: string): string {
  return value.replace(/[^\x21-\x7e]/gu, (ch) => encodeURIComponent(ch));
}

// -------------------------------------------------------------------------
// KV-keyed exact rules
// -------------------------------------------------------------------------

/**
 * Value stored at a `redirect:<id>:<path>` key — the same shape as
 * `StoredRedirect` in `@decocms/blocks/cms` (kept structural here so this
 * module doesn't import the CMS barrel). Temporary is always written as 307;
 * `"legacy"` answers it as 302.
 */
export interface StoredExactRedirect {
  /** Source as written (`sourcePath`). Absent on values written before it existed. */
  from?: string;
  to: string;
  status: 301 | 307;
  discardQueryParameters?: boolean;
}

/** One KV key's worth of exact rules, ready to be written. */
export interface ExactRedirect extends StoredExactRedirect {
  /** `normalizePath(from)` — the KV key suffix. The same in both semantics. */
  path: string;
  /**
   * Earlier rules whose source folds to the same `path` (`/Meia/p` and
   * `/meia/p/`), in write order. `"legacy"` serves the last rule (this one),
   * as it always has; `"fresh"` picks the one whose `from` is the request's
   * pathname byte for byte. Only present when there are any.
   */
  shadowed?: StoredExactRedirect[];
}

/** The JSON written at an `ExactRedirect`'s key: one rule, or all that share it. */
export function storedExactRedirectValue({
  path: _path,
  shadowed,
  ...rule
}: ExactRedirect): StoredExactRedirect | StoredExactRedirect[] {
  return shadowed?.length ? [...shadowed, rule] : rule;
}

/**
 * The rule a KV value answers for `pathname` under the current semantics, or
 * `null`. Accepts one rule or the list `storedExactRedirectValue` writes.
 */
export function selectExactRedirect(
  value: StoredExactRedirect | StoredExactRedirect[],
  pathname: string,
): Redirect | null {
  const rules = Array.isArray(value) ? value : [value];
  const key = normalizePath(pathname);
  if (getRedirectSemantics() === "fresh") {
    const source = sourcePath(pathname);
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      // A value written before `from` was stored can only be checked by key.
      if ((rule.from ?? source) === source) return toMatched(source, rule, 307);
    }
    return null;
  }
  const rule = rules[rules.length - 1];
  if (!rule || loopsWhenFolded(key, rule.to)) return null;
  return toMatched(key, rule, 302);
}

function toMatched(from: string, rule: StoredExactRedirect, temporary: 302 | 307): Redirect {
  const redirect: Redirect = {
    from,
    to: rule.to,
    status: rule.status === 301 ? 301 : temporary,
  };
  if (rule.discardQueryParameters) redirect.discardQueryParameters = true;
  return redirect;
}

// -------------------------------------------------------------------------
// Splitting exact rules out of the decofile (KV-keyed redirects)
// -------------------------------------------------------------------------

export interface SplitRedirectsResult {
  /** The blocks map with every EXACT rule removed. Glob rules stay (they can't
   *  be addressed by key), and a redirect block left with no entries at all is
   *  dropped entirely rather than left as an empty husk. */
  blocks: Record<string, unknown>;
  /** The extracted exact rules, one per KV key (last wins for `"legacy"`,
   *  matching `loadRedirects`; the others ride along in `shadowed`). */
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
 * Independent of the redirect semantics: it runs at sync time, where the
 * worker's choice is unknown. Keys are `normalizePath` (what `"legacy"` has
 * always looked up), and each value carries the source as written so the
 * request-time lookup can apply either semantics (`selectExactRedirect`).
 *
 * Read-only over `blocks`: the returned map shares every untouched value and
 * only clones the redirect blocks it had to rewrite.
 */
const MAX_KV_PATH_BYTES = 400;
const utf8 = new TextEncoder();

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
      const redirect = entry ? toRedirect(entry) : null;
      if (!redirect) continue;
      const from = sourcePath(redirect.from);
      const path = normalizePath(redirect.from);
      // Globs must be scanned in order against the request path, so they can
      // never be a key lookup — they stay in the decofile.
      // Query-scoped rules stay too: the request-time lookup keys by pathname
      // alone, so one KV read per request, not two.
      // Paths too long for a KV key (512 bytes, minus `redirect:<id>:`) stay
      // in memory too — loadRedirects still serves them from the exact map.
      if (
        from.includes("*") ||
        from.includes("?") ||
        utf8.encode(path).length > MAX_KV_PATH_BYTES
      ) {
        kept.push(entry);
        continue;
      }
      const rule: StoredExactRedirect = {
        from,
        to: redirect.to,
        status: isPermanent(entry.type) ? 301 : 307,
      };
      if (redirect.discardQueryParameters) rule.discardQueryParameters = true;
      const previous = exact.get(path);
      const shadowed = previous
        ? [
            ...(previous.shadowed ?? []),
            storedExactRedirectValue({ ...previous, shadowed: undefined }) as StoredExactRedirect,
          ].filter((r) => r.from !== from)
        : [];
      exact.set(path, { path, ...rule, ...(shadowed.length ? { shadowed } : {}) });
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
 * The map key for a source or a request path under the current semantics.
 */
function matchKey(path: string): string {
  return getRedirectSemantics() === "fresh" ? sourcePath(path) : normalizePath(path);
}

/**
 * A redirect source as Fresh's router compared it: the origin of an absolute
 * URL stripped, everything else byte for byte as written — case, trailing
 * slash and query included. A request pathname is already in this form.
 */
export function sourcePath(path: string): string {
  const p = path.trim();

  // If the "from" is a full URL, keep just the pathname (and query, if any).
  if (p.startsWith("http://") || p.startsWith("https://")) {
    try {
      const url = new URL(p);
      return url.pathname + url.search;
    } catch {
      // malformed URL, keep as-is and try the prefix fallback
      const slashIdx = p.indexOf("/", p.indexOf("//") + 2);
      return slashIdx >= 0 ? p.slice(slashIdx) : p;
    }
  }

  return p;
}

/**
 * Folded redirect-source form: origin stripped, leading `/` forced, trailing
 * slash dropped, lower-cased. The `"legacy"` match key.
 *
 * Exported because it is the KV key contract for `redirect:<id>:<path>` in
 * BOTH semantics — the sync script that WRITES the keys and the worker that
 * READS them must agree byte for byte, or a rule is stored under a key nothing
 * ever asks for. Never inline a different normalization on either side.
 */
export function normalizePath(path: string): string {
  let p = path.trim();

  // A full URL keeps just its pathname — the query is not part of this key.
  if (p.startsWith("http://") || p.startsWith("https://")) {
    try {
      p = new URL(p).pathname;
    } catch {
      const slashIdx = p.indexOf("/", p.indexOf("//") + 2);
      p = slashIdx >= 0 ? p.slice(slashIdx) : p;
    }
  }

  if (!p.startsWith("/")) {
    p = `/${p}`;
  }
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p.toLowerCase();
}
