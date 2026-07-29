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
 * Inert unless `DECO_DRAFT_PREVIEW_HOST` names the request's host: upgrading
 * the package must never be enough to start fetching from the network and
 * rendering unpublished content. Host-scoping (rather than a boolean) exists
 * because one deployment commonly serves several domains — the preview domain
 * may render drafts while the production domain, on the same build, must
 * ignore a `?__draft=` entirely.
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

/**
 * Default sandbox origin suffixes — deco-operated domains, so shipping them as
 * defaults adds no SSRF surface: the origin is still configuration, never
 * caller input. `DECO_SANDBOX_ORIGIN_SUFFIXES` overrides (e.g. to pin a local
 * link port: `.localhost:60534`).
 */
export const DEFAULT_SANDBOX_ORIGIN_SUFFIXES = [
  ".preview-studio.decocms.com",
  ".local.studio.decocms.com",
  ".localhost",
];

/**
 * Suffixes are tried in order until one answers — a deployment can serve
 * sandboxes from more than one origin (cluster and desktop-link), and the
 * handle alone does not say which one it lives under.
 */
function readSuffixes(env: Record<string, string | undefined>): string[] {
  const configured = (env.DECO_SANDBOX_ORIGIN_SUFFIXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_SANDBOX_ORIGIN_SUFFIXES;
}

/** Hosts allowed to render drafts (`DECO_DRAFT_PREVIEW_HOST`, comma list). */
function readAllowedHosts(env: Record<string, string | undefined>): string[] {
  return (env.DECO_DRAFT_PREVIEW_HOST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether `host` (as seen on the request) may render drafts.
 *
 * Compared against `DECO_DRAFT_PREVIEW_HOST` verbatim, port included — local
 * dev is `localhost:3100`, not `localhost`. The header is spoofable by a
 * direct-to-origin request, but the sandbox handle is the actual capability;
 * host-scoping bounds blast radius (production domains stay inert), it is not
 * a secret.
 */
export function isDraftHostAllowed(
  host: string | null | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  if (!host) return false;
  const e = envOrProcess(env);
  return readAllowedHosts(e).includes(host.trim().toLowerCase());
}

function envOrProcess(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return (
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {}
  );
}

/**
 * Build the sandbox origin for a handle under ONE configured suffix.
 *
 * The origin comes from configuration, never from caller input, so there is no
 * SSRF surface to defend and no allowlist to keep correct. A `localhost`
 * suffix (local e2e) speaks http; everything else is https.
 */
export function buildDraftOrigin(handle: string, suffix: string): string | null {
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
  const env = envOrProcess(options.env);
  if (readAllowedHosts(env).length === 0) return null;

  const parsed = parseDraftPointer(options.pointer);
  if (!parsed) return null;

  const cached = byVersion.get(parsed.version);
  if (cached) return cached;

  const doFetch = options.fetchImpl ?? fetch;
  // Suffixes are tried in order; the first that answers with parseable JSON
  // wins. A miss on one origin (unreachable, non-2xx, garbage) is expected —
  // the handle only exists under one of them — so every failure falls through
  // to the next rather than aborting the resolve.
  for (const suffix of readSuffixes(env)) {
    const origin = buildDraftOrigin(parsed.handle, suffix);
    if (!origin) continue;

    let res: Response;
    try {
      res = await doFetch(`${origin}/_sandbox/decofile`, { cache: "no-store" });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    let blocks: Record<string, unknown>;
    try {
      blocks = (await res.json()) as Record<string, unknown>;
    } catch {
      continue;
    }

    cacheDraft(parsed.version, blocks);
    return blocks;
  }
  return null;
}

/**
 * True when any host is allowed to preview. A plain env read — callers use it
 * to gate BEFORE touching dynamic APIs (`cookies()`/`headers()`), so an
 * unconfigured site never loses static/ISR rendering. The per-request host
 * match happens later, in `isDraftHostAllowed`.
 */
export function isDraftPreviewEnabled(env?: Record<string, string | undefined>): boolean {
  return readAllowedHosts(envOrProcess(env)).length > 0;
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
