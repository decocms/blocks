/**
 * Draft preview — pull-based decofile override.
 *
 * A Studio sandbox serves the working-tree draft at
 * `GET <origin>/_sandbox/decofile`; a production site pulls it and renders its
 * own real pages against it. This replaces pushing the decofile into a POST
 * body, which only deco's own runtime honours — Next.js and most frameworks
 * render on GET only.
 *
 * This module is the framework-agnostic half: pointer parsing, origin
 * construction, fetching, and version caching. Binding a resolved draft to a
 * request is framework-specific (see `@decocms/nextjs`'s draft wiring) and
 * reaches this module through {@link setDraftOverrideGetter} — the same
 * dependency-injection shape as `setFastDeployKVGetter`, so `blocks` keeps its
 * zero-dependency direction.
 *
 * Inert unless BOTH `DECO_DRAFT_PREVIEW=1` and `DECO_SANDBOX_ORIGIN_SUFFIXES`
 * are set, mirroring Fast Deploy's opt-in: upgrading the package must never be
 * enough to start fetching from the network and rendering unpublished content.
 */

/** A parsed `<handle>@<version>` draft pointer. */
export interface DraftPointer {
  /** Sandbox handle — the subdomain under a configured origin suffix. */
  handle: string;
  /** Content version (the daemon's ETag). Immutable, so safe to cache on. */
  version: string;
}

/**
 * Sandbox handles are `[a-z0-9-]`, always leading with an alphanumeric.
 *
 * Validated BEFORE the handle is interpolated into an authority, so it cannot
 * smuggle `/`, `@`, `:` or userinfo into the URL and redirect the fetch at some
 * other host.
 */
const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

/**
 * Parse `<handle>@<version>`.
 *
 * Requires EXACTLY one `@`: a naive `split("@")` accepts `a@b@c` and silently
 * uses the first two segments, which is how a malformed pointer sneaks past
 * validation. Returns null on anything unexpected — callers fall back to
 * published content.
 */
export function parseDraftPointer(raw: string | null | undefined): DraftPointer | null {
  if (!raw) return null;
  const parts = raw.split("@");
  if (parts.length !== 2) return null;
  const [handle, version] = parts;
  if (!handle || !version) return null;
  if (!HANDLE_RE.test(handle)) return null;
  return { handle, version };
}

/** Configured suffixes, e.g. `.preview-studio.decocms.com,.localhost:3200`. */
function readSuffixes(env: Record<string, string | undefined>): string[] {
  return (env.DECO_SANDBOX_ORIGIN_SUFFIXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the sandbox origin for a handle.
 *
 * The origin comes from CONFIGURED suffixes, never from caller input, so there
 * is no SSRF surface to defend and no allowlist to keep correct. A `localhost`
 * suffix (local e2e) speaks http; everything else is https.
 */
export function buildDraftOrigin(handle: string, suffixes: string[]): string | null {
  const suffix = suffixes[0];
  if (!suffix) return null;
  if (!HANDLE_RE.test(handle)) return null;
  const scheme = suffix.includes("localhost") ? "http" : "https";
  return `${scheme}://${handle}${suffix}`;
}

/**
 * Version cache.
 *
 * Bounded on purpose: a decofile is routinely multi-megabyte, so an unbounded
 * map keyed by version would grow with every save until the process died.
 * Keyed by version (content-addressed), so a hit is always correct.
 */
const MAX_CACHED_VERSIONS = 3;
const byVersion = new Map<string, Record<string, unknown>>();

function cacheDraft(version: string, blocks: Record<string, unknown>): void {
  // Re-insert to make this the most recently used key.
  byVersion.delete(version);
  byVersion.set(version, blocks);
  while (byVersion.size > MAX_CACHED_VERSIONS) {
    const oldest = byVersion.keys().next().value;
    if (oldest === undefined) break;
    byVersion.delete(oldest);
  }
}

/** Test seam — drops every cached version. */
export function clearDraftCache(): void {
  byVersion.clear();
}

export interface ResolveDraftOptions {
  /** Raw `<handle>@<version>` pointer from the request. */
  pointer: string | null | undefined;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to global `fetch`. Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a draft pointer to a decofile, or null to render published content.
 *
 * Null on every failure path — disabled, malformed pointer, unreachable
 * sandbox, non-2xx — because a draft that cannot be resolved must degrade to
 * published rather than break the page. Callers that need to *tell the user*
 * the draft failed should check {@link isDraftPreviewEnabled} and surface it
 * themselves; silently showing published content while the user believes they
 * are looking at a draft is the failure mode worth avoiding.
 */
export async function resolveDraftDecofile(
  options: ResolveDraftOptions,
): Promise<Record<string, unknown> | null> {
  const env =
    options.env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  if (env.DECO_DRAFT_PREVIEW !== "1") return null;

  const parsed = parseDraftPointer(options.pointer);
  if (!parsed) return null;

  const cached = byVersion.get(parsed.version);
  if (cached) return cached;

  const origin = buildDraftOrigin(parsed.handle, readSuffixes(env));
  if (!origin) return null;

  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${origin}/_sandbox/decofile`, { cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let blocks: Record<string, unknown>;
  try {
    blocks = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  cacheDraft(parsed.version, blocks);
  return blocks;
}

/** True when the feature is switched on and configured. Inert otherwise. */
export function isDraftPreviewEnabled(env?: Record<string, string | undefined>): boolean {
  const e =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  return e.DECO_DRAFT_PREVIEW === "1" && readSuffixes(e).length > 0;
}

// ---------------------------------------------------------------------------
// Request binding (dependency-injected by the framework binding)
// ---------------------------------------------------------------------------

type DraftOverrideGetter = () => Record<string, unknown> | null | undefined;

let getDraftOverride: DraftOverrideGetter = () => undefined;

/**
 * Inject the request-scoped draft getter.
 *
 * Binding a value to "the current request" is framework-specific and `blocks`
 * must not know about any framework: `@decocms/nextjs` backs this with React
 * `cache()` (App Router has no AsyncLocalStorage request scope of its own —
 * `RequestContext.run` is never entered there). Bindings that do have an ALS
 * request scope can back it with that instead. Never called → returns
 * undefined → `loadBlocks()` behaves exactly as before.
 */
export function setDraftOverrideGetter(getter: DraftOverrideGetter): void {
  getDraftOverride = getter;
}

/** The current request's draft blocks, if a binding registered one. */
export function getRequestDraftOverride(): Record<string, unknown> | null | undefined {
  return getDraftOverride();
}
