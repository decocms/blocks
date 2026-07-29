/**
 * Draft preview — pull-based decofile override.
 *
 * A Studio preview serves the working-tree draft at
 * `GET <origin>/_sandbox/decofile`; a production site pulls it and renders its
 * own real pages against it. This replaces pushing the decofile into a POST
 * body, which only deco's own runtime honours — Next.js and most frameworks
 * render on GET only.
 *
 * This module is the framework-agnostic half: token parsing, origin
 * validation, fetching, and version caching. Binding a resolved draft to a
 * request is framework-specific (see `@decocms/nextjs`'s draft wiring) and
 * reaches this module through {@link setDraftOverrideGetter} — the same
 * dependency-injection shape as `setFastDeployKVGetter`, so `blocks` keeps its
 * zero-dependency direction.
 *
 * Inert unless `DECO_ALLOWED_PREVIEW_HOSTS` names the request's host: upgrading
 * the package must never be enough to start fetching from the network and
 * rendering unpublished content. Host-scoping (rather than a boolean) exists
 * because one deployment commonly serves several domains — the preview domain
 * may render drafts while the production domain, on the same build, must
 * ignore a `?__draft=` entirely.
 */

/**
 * A parsed `?__draft=` token: `<host[:port]>@<version>`.
 *
 * The token carries the AUTHORITY of the draft content API, never a scheme or
 * path — a full URL would be an SSRF vector, and the scheme is derived from
 * the matched domain instead. Reserved evolution: a future signed token uses a
 * distinguishable prefix (e.g. `s1.`), so this strict two-part parse rejects
 * it cleanly rather than half-reading it.
 */
export interface DraftPointer {
  /** Content-API authority, e.g. `abc.preview-studio.decocms.com` or `abc.localhost:60534`. */
  host: string;
  /** Opaque content version (the server's ETag). Immutable → safe cache key. */
  version: string;
}

/** Lowercase DNS hostname, at least two labels (a bare label can't match any domain). */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PORT_RE = /^[0-9]{1,5}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Parse `<host[:port]>@<version>`. Null on anything unexpected — callers fall
 * back to published content. Requires EXACTLY one `@`: a naive split accepts
 * `a@b@c` and silently uses the first two segments.
 */
export function parseDraftPointer(raw: string | null | undefined): DraftPointer | null {
  if (!raw) return null;
  const parts = raw.split("@");
  if (parts.length !== 2) return null;
  const [authority, version] = parts;
  if (!authority || !version || !VERSION_RE.test(version)) return null;

  const [host, port, extra] = authority.toLowerCase().split(":");
  if (extra !== undefined) return null;
  if (!host || !HOST_RE.test(host)) return null;
  if (port !== undefined && !PORT_RE.test(port)) return null;

  return { host: port === undefined ? host : `${host}:${port}`, version };
}

/**
 * Domains the draft content API may live under — deco-operated, so shipping
 * them as defaults adds no SSRF surface. `DECO_PREVIEW_API_DOMAINS` overrides
 * the whole list when set. Entries are dot-prefixed suffixes, which guarantees
 * a label boundary on match (`evil-preview-studio.decocms.com` cannot pass).
 */
export const DEFAULT_PREVIEW_API_DOMAINS = [
  ".preview-studio.decocms.com",
  ".local.studio.decocms.com",
  ".localhost",
];

function readApiDomains(env: Record<string, string | undefined>): string[] {
  const configured = (env.DECO_PREVIEW_API_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_PREVIEW_API_DOMAINS;
}

/**
 * Validate the token's authority against the configured domains and derive the
 * fetch origin, or null if no domain admits it.
 *
 * The token proposes, configuration disposes: only the hostname-suffix match
 * decides, so a caller can steer WHICH label under your domains, never which
 * domains. Scheme is derived — http for localhost-ish domains, https
 * otherwise — and an explicit port is allowed only there, so a public-domain
 * token cannot aim at odd ports.
 */
export function previewApiOriginForHost(
  authority: string,
  env?: Record<string, string | undefined>,
): string | null {
  const [host, port] = authority.toLowerCase().split(":");
  if (!host) return null;
  const domain = readApiDomains(envOrProcess(env)).find(
    (d) => host.length > d.length && host.endsWith(d),
  );
  if (!domain) return null;
  const local = domain.includes("localhost");
  if (port !== undefined && !local) return null;
  return `${local ? "http" : "https"}://${host}${port === undefined ? "" : `:${port}`}`;
}

/** Hosts allowed to render drafts (`DECO_ALLOWED_PREVIEW_HOSTS`, comma list). */
function readAllowedHosts(env: Record<string, string | undefined>): string[] {
  return (env.DECO_ALLOWED_PREVIEW_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether `host` (as seen on the request) may render drafts.
 *
 * Compared against `DECO_ALLOWED_PREVIEW_HOSTS` verbatim, port included —
 * local dev is `localhost:3100`, not `localhost`. The header is spoofable by a
 * direct-to-origin request, but the draft id is the actual capability;
 * host-scoping bounds blast radius (production domains stay inert), it is not
 * a secret.
 */
export function isDraftHostAllowed(
  host: string | null | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  if (!host) return false;
  return readAllowedHosts(envOrProcess(env)).includes(host.trim().toLowerCase());
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
 * Version cache. Bounded on purpose: a decofile is routinely multi-megabyte,
 * so an unbounded map keyed by version would grow with every save until the
 * process died. Content-addressed, so a hit is always correct.
 */
const MAX_CACHED_VERSIONS = 3;
const byVersion = new Map<string, Record<string, unknown>>();

function cacheDraft(version: string, blocks: Record<string, unknown>): void {
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
  /** Raw `<host[:port]>@<version>` token from the request. */
  pointer: string | null | undefined;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to global `fetch`. Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a draft token to a decofile, or null to render published content.
 *
 * Null on every failure path — disabled, malformed token, disallowed origin,
 * unreachable, non-2xx — because a draft that cannot be resolved must degrade
 * to published rather than break the page.
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

  const origin = previewApiOriginForHost(parsed.host, env);
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
 * `cache()` (App Router has no AsyncLocalStorage request scope of its own).
 * Never called → returns undefined → `loadBlocks()` behaves exactly as before.
 */
export function setDraftOverrideGetter(getter: DraftOverrideGetter): void {
  getDraftOverride = getter;
}

/** The current request's draft blocks, if a binding registered one. */
export function getRequestDraftOverride(): Record<string, unknown> | null | undefined {
  return getDraftOverride();
}
