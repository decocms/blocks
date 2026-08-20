import * as asyncHooks from "node:async_hooks";
import { djb2Hex } from "../sdk/djb2";
import { getRequestDraftOverride } from "./draftSource";

export type Resolvable = {
  __resolveType?: string;
  [key: string]: unknown;
};

export type DecoPage = {
  name: string;
  path?: string;
  sections: Resolvable[] | Resolvable;
  seo?: Record<string, unknown>;
};

// globalThis-backed storage: TanStack Start server function split modules
// may get isolated module instances. globalThis ensures shared state.
const G = globalThis as any;
if (!G.__deco) G.__deco = {};

let blockData: Record<string, unknown> = G.__deco.blockData ?? {};
let revision: string | null = G.__deco.revision ?? null;

interface ALSLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

// AsyncLocalStorage might not be available in client builds (Vite replaces
// node:async_hooks with an empty shim). The namespace import avoids Rollup's
// named-export validation, and the runtime check prevents construction errors.
const ALS = (asyncHooks as any).AsyncLocalStorage;

/**
 * A scoped blocks override, tagged with how it composes over the base:
 * - `merge`: a PARTIAL decofile (admin preview payloads) — entries replace or
 *   delete their base twins, everything else survives (see mergeOverride).
 * - `snapshot`: a COMPLETE decofile (draft preview) — it replaces the
 *   file-backed base entirely; only synthetic base blocks survive (see
 *   applyDraftSnapshot).
 */
interface BlocksOverride {
  mode: "merge" | "snapshot";
  blocks: Record<string, unknown>;
}

const blocksOverrideStorage: ALSLike<BlocksOverride> = ALS
  ? new ALS()
  : { getStore: () => undefined, run: (_s: any, fn: any) => fn() };

// ---------------------------------------------------------------------------
// Change listeners
// ---------------------------------------------------------------------------

type ChangeListener = (
  blocks: Record<string, unknown>,
  revision: string,
) => void;
const changeListeners: ChangeListener[] = [];

/** Register a callback invoked whenever setBlocks() changes the decofile. */
export function onChange(listener: ChangeListener) {
  changeListeners.push(listener);
  return () => {
    const idx = changeListeners.indexOf(listener);
    if (idx >= 0) changeListeners.splice(idx, 1);
  };
}

// ---------------------------------------------------------------------------
// Revision hashing
// ---------------------------------------------------------------------------

function computeRevision(blocks: Record<string, unknown>): string {
  return djb2Hex(JSON.stringify(blocks));
}

// ---------------------------------------------------------------------------
// Block management
// ---------------------------------------------------------------------------

/**
 * Set the blocks data. Called at startup with generated blocks,
 * and by the admin on hot-reload.
 * Notifies all onChange listeners and updates the revision.
 */
export function setBlocks(blocks: Record<string, unknown>) {
  blockData = blocks;
  revision = computeRevision(blocks);

  // Persist to globalThis so other module instances see them
  G.__deco.blockData = blockData;
  G.__deco.revision = revision;

  for (const listener of [...changeListeners]) {
    try {
      listener(blocks, revision);
    } catch (e) {
      console.error("[CMS] onChange listener error:", e);
    }
  }
}

/**
 * Canonicalise a block key so an override block matches its base twin even when
 * the two decofiles disagree on percent-encoding of the key.
 *
 * The site's published decofile encodes special characters in block keys
 * (`pages-Home%20(principal)-287364`); the Studio draft-preview sandbox emits
 * them raw (`pages-Home (principal)-287364`). Decoding collapses both spellings
 * to the same canonical form. Defensive: a malformed `%` sequence makes
 * `decodeURIComponent` throw, so fall back to the raw key rather than 500 the
 * merge.
 */
function canonicalBlockKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/**
 * Merge an override decofile on top of the base blocks.
 *
 * An override entry REPLACES the base block of the same logical key — including
 * a base twin spelled with different percent-encoding. A naive key-merge would
 * instead ADD the differently-encoded override block, leaving two `pages-`
 * blocks with the same `.path`; `findPageByPath` returns the first (base) one,
 * so a draft-preview edit would silently never render. Canonicalising the base
 * keys lets the override find and displace its twin.
 *
 * A `null`/`undefined` override value deletes the block (its twin too), so a
 * draft that removes a block is honoured.
 */
function mergeOverride(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  const baseByCanonical = new Map<string, string>();
  for (const baseKey of Object.keys(merged)) {
    baseByCanonical.set(canonicalBlockKey(baseKey), baseKey);
  }
  for (const [key, value] of Object.entries(override)) {
    const twin = baseByCanonical.get(canonicalBlockKey(key));
    if (twin !== undefined && twin !== key) delete merged[twin];
    if (value === null || value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Base blocks that are NOT file-backed: synthesized by the generator (CSV
 * redirect loaders, keyed `__csv_redirects__<file>`). A draft snapshot is the
 * complete truth of `.deco/blocks/` but knows nothing about these, so they
 * survive the snapshot instead of vanishing from the preview.
 */
const SYNTHETIC_BLOCK_KEY_PREFIX = "__csv_redirects__";

/**
 * Compose a draft SNAPSHOT over the base blocks: the draft is the complete
 * decofile at the branch head, so it REPLACES every file-backed base block —
 * a block absent from the draft was deleted and must not render. Only
 * synthetic base blocks (see SYNTHETIC_BLOCK_KEY_PREFIX) survive. `null`
 * draft values are tolerated as deletions for defensiveness.
 */
function applyDraftSnapshot(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith(SYNTHETIC_BLOCK_KEY_PREFIX)) out[key] = value;
  }
  for (const [key, value] of Object.entries(draft)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Load the current blocks. If running inside a `withBlocksOverride` /
 * `withDraftBlocks` scope (admin preview / draft endpoints) or a request
 * carrying an ambient draft, that override composes over the base blocks
 * according to its mode.
 */
export function loadBlocks(): Record<string, unknown> {
  // Re-sync from globalThis in case setBlocks was called in another module instance
  if (G.__deco.blockData && G.__deco.blockData !== blockData) {
    blockData = G.__deco.blockData;
    revision = G.__deco.revision ?? null;
  }

  // An explicit scope (the caller named the exact blocks to render) wins over
  // an ambient draft: a draft pointer on the same request must not silently
  // replace it.
  const scoped = blocksOverrideStorage.getStore();
  if (scoped) {
    return scoped.mode === "merge"
      ? mergeOverride(blockData, scoped.blocks)
      : applyDraftSnapshot(blockData, scoped.blocks);
  }
  const draft = getRequestDraftOverride();
  if (draft) return applyDraftSnapshot(blockData, draft);
  return blockData;
}

/** Get the current decofile revision hash. Changes on each setBlocks(). */
export function getRevision(): string | null {
  return revision;
}

/**
 * Run a function with a temporary blocks overlay.
 *
 * Used by admin preview: the admin sends a partial decofile (only the
 * blocks that changed), and `loadBlocks()` returns the merged result
 * for the duration of the render. Other concurrent requests are not
 * affected (AsyncLocalStorage is per-request scoped).
 */
export function withBlocksOverride<T>(
  override: Record<string, unknown>,
  fn: () => T,
): T {
  return blocksOverrideStorage.run({ mode: "merge", blocks: override }, fn);
}

/**
 * Run a function with a COMPLETE draft decofile (snapshot semantics — see
 * applyDraftSnapshot). Used by secondary endpoints (`/deco/invoke`) that
 * re-resolve the page's draft from the raw request: the draft must compose
 * exactly like the page render, deletions included, or a lazy section could
 * render a block the page no longer has.
 */
export function withDraftBlocks<T>(
  draft: Record<string, unknown>,
  fn: () => T,
): T {
  return blocksOverrideStorage.run({ mode: "snapshot", blocks: draft }, fn);
}

// Higher key wins. Compared lexicographically:
//   [hasNoWildcard, literalSegments, paramSegments]
//
// `hasNoWildcard` is the top key so a literal-only path always beats any
// pattern that contains `*` or `{group}?` — including the empty-parts case
// `/` (literals=0) vs the catch-all `/{prefix/}?*` (literals=0, params=1).
// Without this, the URLPattern fix (#213/#214) inadvertently lets a
// `/{group/}?*` catch-all out-rank an exact `/` home page because the
// `{group` segment counted as a param. See deco-sites/granadobr-tanstack
// where `/` was being routed to the granado PDP/PLP block's NotFound
// fallback.
//
// Order produced:
//   /foo/bar (no wildcard, literals=2) > /foo/:x (no wildcard, lit=1, param=1)
//   /foo (no wildcard) > /{granado/}?*  (has wildcard) > /*
function pathSpecificityKey(path: string): [number, number, number] {
  const parts = path.split("/").filter(Boolean);
  let literals = 0;
  let params = 0;
  let hasWildcard = false;
  for (const part of parts) {
    // A wildcard is any `*`, optional group `{...}?`, or any segment
    // bearing `?` — these all make the pattern match strictly more URLs
    // than a plain literal/`:param`/`:slug([\w-]+)` segment, so they
    // are demoted to "least specific" together regardless of count.
    if (part.includes("*") || /[{}?]/.test(part)) {
      hasWildcard = true;
    } else if (part.startsWith(":") || part.startsWith("$")) {
      params++;
    } else {
      literals++;
    }
  }
  return [hasWildcard ? 0 : 1, literals, params];
}

export function getAllPages(): Array<{ key: string; page: DecoPage }> {
  const blocks = loadBlocks();
  const pages: Array<{
    key: string;
    page: DecoPage;
    key2: [number, number, number];
  }> = [];

  for (const [key, block] of Object.entries(blocks)) {
    if (!key.startsWith("pages-")) continue;
    const page = block as DecoPage;
    if (!page.sections) continue;
    if (!page.path) continue;

    pages.push({ key, page, key2: pathSpecificityKey(page.path) });
  }

  return pages
    .sort((a, b) => {
      for (let i = 0; i < a.key2.length; i++) {
        if (a.key2[i] !== b.key2[i]) return b.key2[i] - a.key2[i];
      }
      return 0;
    })
    .map(({ key, page }) => ({ key, page }));
}

// Module-scoped (NOT `declare global`) ambient declaration for the
// `URLPattern` Web API. It's natively available at runtime in browsers,
// Cloudflare Workers, Deno, and Node 24+, but its type declarations aren't
// consistently present: TypeScript's bundled lib.dom.d.ts doesn't ship it
// yet, and @types/node only started shipping a global augmentation for it
// in newer major versions (via `node/web-globals/url.d.ts`).
//
// A `declare global` shim here would merge with @types/node's own global
// `URLPattern`/`URLPatternResult` augmentation whenever a new-enough
// @types/node wins the workspace's package hoist — and merging two
// independently-authored global interfaces under the same name throws
// TS2430 ("incorrectly extends") the moment their shapes don't line up
// structurally. Declaring `URLPattern` and its result shape as file-local
// bindings instead (no `declare global`) means this file typechecks the
// same regardless of whether @types/node has its own `URLPattern` global or
// not — there's nothing for a local declaration to collide with.
type MatchPatternResult = {
  pathname: { groups: Record<string, string | undefined> };
};
declare const URLPattern: {
  new (init: {
    pathname: string;
  }): {
    exec(input: { pathname: string }): MatchPatternResult | null;
  };
};

/**
 * Match a CMS page path pattern against a URL path.
 *
 * Mirrors the original deco-cx/deco Fresh framework
 * (`runtime/features/render.tsx`) by delegating to the platform's native
 * `URLPattern`. Supports the full URLPattern syntax that the admin emits:
 * `:slug`, `:slug([\w-]+)`, optional groups `{...}?`, and trailing `*`
 * splats. Splats are exposed as the standard numbered groups (`"0"`, `"1"`,
 * …), matching the Fresh shape.
 *
 * Malformed patterns return `null` instead of throwing — bad CMS data must
 * never take down the worker.
 *
 * A MISSING `URLPattern` API, however, throws loudly and immediately: the
 * try/catch below exists to absorb bad *patterns*, and letting it also
 * swallow a `ReferenceError` from an old runtime turns "wrong Node version"
 * into "every CMS page silently 404s" — the worst possible failure mode.
 * `URLPattern` is native in browsers, workerd, Deno, and Node >= 24 (this
 * package's `engines` floor). Node 22 and older lack it.
 */
export function matchPath(
  pattern: string,
  urlPath: string,
): Record<string, string> | null {
  if (typeof URLPattern === "undefined") {
    throw new Error(
      "@decocms/blocks: this runtime has no URLPattern Web API, so CMS page " +
        "paths cannot be matched. URLPattern is native in browsers, " +
        "Cloudflare workerd, Deno, and Node.js >= 24 — you are most likely " +
        "running Node <= 22. Upgrade the runtime to Node 24+ (see this " +
        'package\'s "engines" field).',
    );
  }
  let result: MatchPatternResult | null;
  try {
    result = new URLPattern({ pathname: pattern }).exec({ pathname: urlPath });
  } catch {
    return null;
  }
  if (!result) return null;

  const groups = result.pathname.groups as Record<string, string | undefined>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(groups)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Extract the site-wide SEO config from the "Site" app block.
 *
 * In the original deco-cx/deco framework this is `ctx.seo` — the app-level
 * SEO configuration that provides fallback title, description, and templates
 * when page-level seo blocks don't supply them.
 */
export function getSiteSeo(): {
  title?: string;
  description?: string;
  titleTemplate?: string;
  descriptionTemplate?: string;
  image?: string;
  favicon?: string;
  themeColor?: string;
  noIndexing?: boolean;
} {
  const blocks = loadBlocks();
  const site = (blocks["Site"] ?? blocks["site"]) as Record<string, unknown> | undefined;
  if (!site) return {};
  const seo = site.seo as Record<string, unknown> | undefined;
  if (!seo) return {};
  return seo as ReturnType<typeof getSiteSeo>;
}

export function findPageByPath(
  targetPath: string,
): { page: DecoPage; params: Record<string, string>; blockKey: string } | null {
  const allPages = getAllPages();

  for (const { key, page } of allPages) {
    if (!page.path) continue;
    const params = matchPath(page.path, targetPath);
    if (params !== null) return { page, params, blockKey: key };
  }

  return null;
}
