/**
 * Draft preview — pull-based decofile snapshot.
 *
 * Studio serves the draft decofile (the merged `.deco/blocks/*.json` at the
 * branch head) from its decofile API
 * (`GET <origin>/api/<org>/decofile/<virtualMcpId>/<branch>?token=…`); a
 * production site pulls it and renders its own real pages against it. This
 * replaces pushing the decofile into a POST body, which only deco's own
 * runtime honours — Next.js and most frameworks render on GET only.
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
 * A parsed `?__draft=` token: `<host[:port]><path[?query]>@<version>`.
 *
 * The token carries the AUTHORITY + PATH of the draft content API, never a
 * scheme — a full URL would be an SSRF vector, and the scheme is derived from
 * the matched domain instead. The path is REQUIRED and typically addresses
 * Studio's decofile API (`/api/<org>/decofile/<virtualMcpId>/<branch>?token=…`);
 * its query carries the signed draft grant.
 */
export interface DraftPointer {
  /** Content-API authority, e.g. `studio.decocms.com` or `localhost:4000`. */
  host: string;
  /** Path (+ query) on that authority serving the decofile JSON. */
  path: string;
  /** Opaque content version (the branch head sha / server ETag). Immutable → safe cache key. */
  version: string;
}

/** Lowercase DNS hostname. A single label is allowed — exact-host domain
 * entries (`localhost`, `local.studio.decocms.com`) can admit it. */
const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const PORT_RE = /^[0-9]{1,5}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Rooted path with an optional query; conservative charset, no `@`/`#`/space. */
const PATH_RE = /^\/[A-Za-z0-9/_.%~=&?-]*$/;

/**
 * Parse `<host[:port]><path>@<version>`. Null on anything unexpected — callers
 * fall back to published content. Splits on the LAST `@` (neither the path
 * charset nor a signed token may contain one, so a stray `@` fails validation
 * rather than being half-read).
 */
export function parseDraftPointer(
  raw: string | null | undefined,
): DraftPointer | null {
  if (!raw) return null;
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  const authorityAndPath = raw.slice(0, at);
  const version = raw.slice(at + 1);
  if (!VERSION_RE.test(version)) return null;

  const slash = authorityAndPath.indexOf("/");
  if (slash === -1) return null;
  const authority = authorityAndPath.slice(0, slash).toLowerCase();
  const path = authorityAndPath.slice(slash);
  if (!PATH_RE.test(path)) return null;

  const [host, port, extra] = authority.split(":");
  if (extra !== undefined) return null;
  if (!host || !HOST_RE.test(host)) return null;
  if (port !== undefined && !PORT_RE.test(port)) return null;

  return {
    host: port === undefined ? host : `${host}:${port}`,
    path,
    version,
  };
}

/**
 * Domains the draft content API may live under — deco-operated, so shipping
 * them as defaults adds no SSRF surface. `DECO_PREVIEW_API_DOMAINS` overrides
 * the whole list when set.
 *
 * Two entry shapes: a dot-prefixed entry is a suffix match with a guaranteed
 * label boundary (`evil-decocms.com` cannot pass `.decocms.com`); a bare entry
 * is an exact-host match (needed for `localhost` and dev origins, which no
 * suffix can admit). Order matters only for the local/port rule: the first
 * matching entry decides whether a port and `http` are allowed.
 */
export const DEFAULT_PREVIEW_API_DOMAINS = [
  "local.studio.decocms.com", // native/web dev origin (http, explicit port)
  "localhost",
  "127.0.0.1", // loopback dev — `localhost` can resolve to a different (IPv6) server
  ".localhost",
  ".decocms.com", // hosted Studio (decofile API) + preview daemons
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
  const domain = readApiDomains(envOrProcess(env)).find((d) =>
    d.startsWith(".") ? host.length > d.length && host.endsWith(d) : host === d,
  );
  if (!domain) return null;
  // Local entries may carry an explicit port; public domains may not (a
  // public-domain token must not steer the fetch at odd ports).
  const local =
    domain === "localhost" ||
    domain === "127.0.0.1" ||
    domain.endsWith(".localhost") ||
    domain === "local.studio.decocms.com";
  if (port !== undefined && !local) return null;
  // Scheme is derived, never taken from the token. Plain-loopback dev hosts
  // are http; local.studio.decocms.com is the native app's TLS dev origin
  // (locally-trusted cert), so it — like every public domain — is https.
  const insecure =
    domain === "localhost" ||
    domain === "127.0.0.1" ||
    domain.endsWith(".localhost");
  return `${insecure ? "http" : "https"}://${host}${port === undefined ? "" : `:${port}`}`;
}

/**
 * Hosts declared by the site itself (the global `site` block's `previewHosts`),
 * installed once at setup time by the framework binding.
 *
 * MUST be fed from the setup-time base blocks, never from `loadBlocks()` at
 * request time: the request path merges the draft override, and an allowlist
 * readable through the override could be rewritten by the very draft it gates.
 */
// globalThis-backed, like the block loader itself: bundlers can duplicate
// this module across graphs, and a plain module variable set in one instance
// is invisible to the others. (The MIDDLEWARE runtime is a separate world
// even so — which is why the page-side gate is the authoritative one and the
// middleware only hard-gates when the env override is present.)
const G = globalThis as { __decoDraftHosts?: string[] };

/** Install the site-declared preview hosts. Called by the framework binding at setup. */
export function setDraftPreviewHosts(hosts: readonly unknown[]): void {
  G.__decoDraftHosts = hosts
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Hosts allowed to render drafts.
 *
 * The site block is the expected source — the opt-in lives in the repo,
 * reviewed in a PR, versioned with branches. `DECO_ALLOWED_PREVIEW_HOSTS`
 * REPLACES it when set: an operational escape hatch (kill a bad value without
 * a deploy, add a machine-specific port) — not the primary configuration.
 */
function readAllowedHosts(env: Record<string, string | undefined>): string[] {
  const fromEnv = (env.DECO_ALLOWED_PREVIEW_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : (G.__decoDraftHosts ?? []);
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
  return readAllowedHosts(envOrProcess(env)).includes(
    host.trim().toLowerCase(),
  );
}

/**
 * True when any host is allowed to preview. A plain env read — callers use it
 * to gate BEFORE touching dynamic APIs (`cookies()`/`headers()`), so an
 * unconfigured site never loses static/ISR rendering. The per-request host
 * match happens later, in `isDraftHostAllowed`.
 */
export function isDraftPreviewEnabled(
  env?: Record<string, string | undefined>,
): boolean {
  return readAllowedHosts(envOrProcess(env)).length > 0;
}

function envOrProcess(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return (
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ??
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
  /** Raw `<host[:port]><path>@<version>` token from the request. */
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

  // Origin validation BEFORE the cache: a cached version must never be served
  // for a pointer whose authority the configuration would reject.
  const origin = previewApiOriginForHost(parsed.host, env);
  if (!origin) return null;

  const cached = byVersion.get(parsed.version);
  if (cached) return cached;

  const doFetch = options.fetchImpl ?? fetch;
  // The pointer's version rides along as `v=`, making the fetch URL fully
  // content-addressed (path + token + version). Today the server serves it
  // no-store either way — token-protected drafts are deliberately NOT
  // shared-cacheable (edge caches can't re-validate the grant, so revocation
  // wouldn't propagate). The param still earns its place: version-tagged
  // access logs, and it's the prerequisite for edge-validated caching later
  // (a CDN worker checking the token per request, keyed on path+version)
  // without another runtime deploy.
  const url = new URL(parsed.path, origin);
  url.searchParams.append("v", parsed.version);
  let res: Response;
  try {
    res = await doFetch(url.toString(), { cache: "no-store" });
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
// Request-level resolution (framework-agnostic; for secondary endpoints)
// ---------------------------------------------------------------------------

/**
 * Cookie the draft pointer travels in across navigation. The Next binding's
 * middleware sets it on entry; a SECONDARY endpoint that must honour the same
 * draft — `/deco/invoke`, which is a separate request from the page render —
 * reads it back off the raw Request here.
 *
 * Duplicated (as a plain literal) in `@decocms/nextjs`'s client-safe
 * `draftConstants`, because the client badge cannot import this server-only
 * module. A parity test keeps the two in lock-step.
 */
export const DRAFT_COOKIE_NAME = "__deco_draft";
/** Query param that enters draft mode; `off` leaves it. */
export const DRAFT_QUERY_PARAM = "__draft";

/** Read one cookie value out of a raw `Cookie:` header. */
function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * The draft pointer a raw Request is carrying: `?__draft=` wins, the cookie
 * carries navigation, `off` exits. Same precedence as the Next binding's
 * page-side `selectDraftPointer`, but reads straight off the Request so it
 * works in a plain route handler (no `next/headers`, no React scope).
 */
export function draftPointerFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const param = url.searchParams.get(DRAFT_QUERY_PARAM);
  if (param === "off") return null;
  if (param) return param;
  return readCookieValue(request.headers.get("cookie"), DRAFT_COOKIE_NAME);
}

export interface ResolveDraftForRequestOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the draft decofile a raw Request is asking for, or null to fall back
 * to published blocks.
 *
 * Applies the SAME gate as the page path — allowlist non-empty, request host
 * allowed, pointer valid, origin allowed, fetch OK — so a secondary endpoint
 * can bind the identical draft the page is rendering instead of silently
 * serving published content. Wrap the endpoint's work in
 * `withBlocksOverride(blocks, ...)` with the result; null means "don't wrap".
 *
 * This is what lets `/deco/invoke` (client-fetched lazy sections, self-fetched
 * section loaders) honour a draft: the draft binding lives in per-request state
 * that does not travel across an HTTP hop, so the endpoint must re-resolve it
 * from the request it received.
 */
export async function resolveDraftForRequest(
  request: Request,
  options: ResolveDraftForRequestOptions = {},
): Promise<Record<string, unknown> | null> {
  const env = envOrProcess(options.env);
  if (readAllowedHosts(env).length === 0) return null;
  const pointer = draftPointerFromRequest(request);
  if (!pointer) return null;
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!isDraftHostAllowed(host, env)) return null;
  return resolveDraftDecofile({ pointer, env, fetchImpl: options.fetchImpl });
}

// ---------------------------------------------------------------------------
// Request binding (dependency-injected by the framework binding)
// ---------------------------------------------------------------------------

type DraftOverrideGetter = () => Record<string, unknown> | null | undefined;

// globalThis-backed like the hosts above: bundlers can duplicate this module
// across graphs (nested node_modules installs, RSC layer splits), and a getter
// registered on one instance's module variable is invisible to the copy
// `loadBlocks()` imports — the framework binding then resolves the draft while
// the render silently serves published content.
const GG = globalThis as { __decoDraftOverrideGetter?: DraftOverrideGetter };

/**
 * Inject the request-scoped draft getter.
 *
 * Binding a value to "the current request" is framework-specific and `blocks`
 * must not know about any framework: `@decocms/nextjs` backs this with React
 * `cache()` (App Router has no AsyncLocalStorage request scope of its own).
 * Never called → returns undefined → `loadBlocks()` behaves exactly as before.
 */
export function setDraftOverrideGetter(getter: DraftOverrideGetter): void {
  GG.__decoDraftOverrideGetter = getter;
}

/** The current request's draft blocks, if a binding registered one. */
export function getRequestDraftOverride():
  | Record<string, unknown>
  | null
  | undefined {
  return GG.__decoDraftOverrideGetter?.();
}
