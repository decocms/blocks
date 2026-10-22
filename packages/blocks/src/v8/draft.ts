/**
 * Draft pointers (see /next/api-reference#draft-pointers): the string
 * `<host[:port]><path[?query]>@<version>` that names a draft, and what
 * `cms.readVersion` and `cms.draftCookie` read and write to carry one (or a
 * published release's commit SHA) from a `?__draft=` link into a cookie. The
 * host check against the preview hosts is the CMS's: these read the request
 * only.
 *
 * A version is a draft pointer or a release's commit SHA, nothing else. A
 * pointer's query may force variants, which are part of the draft it names:
 *
 * - `__variant=<block>@<path>=<index>`: a variant the preview forces, one per
 *   multivariate (`variants`).
 *
 * A Studio preview link carries more than the version: the moment it shows
 * and the tests and campaigns it switches on or off. They ride in the same
 * query (a pointer's, or after a SHA: `<sha>?__at=…&__test=…`), and
 * `parseVersion` lifts them out into the client's other options:
 *
 * - `__at=<ISO date-time with offset>`: the client's `date`.
 * - `__test=<name>=on|off`: a test in the client's `experiments`.
 * - `__campaign=<name>=on|off`: a campaign in the client's `campaigns`.
 *
 * Each value is URL-encoded.
 */
import type { Assignments } from "./experiments.ts";
import type { DraftPointer, ForcedVariant, RequestLike, RequestVersion } from "./types.ts";

/** The draft cookie's name. Not exported from the package: reading it directly would skip the host check. */
const DRAFT_COOKIE = "__deco_draft";

/** The draft link's query parameter. Shared with `./preview` (the badge's links); not exported from the package. */
export const DRAFT_PARAM = "__draft";
const DRAFT_OFF = "off";

/** Lowercase DNS name; a single label (`localhost`) is allowed. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const PORT_RE = /^[0-9]{1,5}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Rooted path with an optional query; no `@`, `#`, whitespace or scheme characters. */
const PATH_RE = /^\/[A-Za-z0-9/_.%~=&?-]*$/;
const MAX_POINTER_LENGTH = 4096;
const VARIANT_PARAM = "__variant=";
const AT_PARAM = "__at=";
const TEST_PARAM = "__test=";
const CAMPAIGN_PARAM = "__campaign=";
/** The parameters of a preview link that aren't part of the version. */
const PREVIEW_PARAMS = [AT_PARAM, TEST_PARAM, CAMPAIGN_PARAM];
/** An ISO 8601 date-time with its offset (`Z` or `±hh:mm`): the moment a preview shows. */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const INDEX_RE = /^(0|[1-9][0-9]{0,3})$/;
/** A published release: its git commit SHA (SHA-1, 40 lowercase hex). */
const REVISION_RE = /^[0-9a-f]{40}$/;

/** A version, read: a published release (by its commit SHA) or a draft. */
type ClientVersion = { kind: "revision"; sha: string } | { kind: "draft"; pointer: DraftPointer };

/**
 * What `cms.client({ version })` reads: a published release's commit SHA (40
 * lowercase hex, nothing after it) or a draft pointer. `null` for anything
 * else, a preview link's `__at`, `__test` or `__campaign` included: those
 * are the client's `date`, `experiments` and `campaigns` (`parseVersion`).
 */
export function parseClientVersion(value: string): ClientVersion | null {
  if (REVISION_RE.test(value)) return { kind: "revision", sha: value };
  const pointer = parseDraftPointer(value);
  return pointer === null ? null : { kind: "draft", pointer };
}

/**
 * A Studio link's value (what `?__draft=` and the draft cookie carry): the
 * version, a draft pointer or a published release's commit SHA, and the
 * preview's moment and switched tests and campaigns, lifted out of its query
 * as the client's `date`, `experiments` and `campaigns`. `null` for a value
 * that is neither, or whose preview parameters don't parse (a second `__at`,
 * a state other than `on` or `off`). The last `__test` or `__campaign` for a
 * name wins. Spread it into `cms.client()`.
 */
export function parseVersion(value: string | null | undefined): RequestVersion | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_POINTER_LENGTH) {
    return null;
  }
  const head = value.indexOf("?");
  if (REVISION_RE.test(head === -1 ? value : value.slice(0, head))) {
    if (head === -1) return { version: value };
    const preview = liftPreview(value.slice(head + 1));
    // After a SHA, only the preview's own parameters.
    if (preview === null || preview.kept.length > 0) return null;
    return { version: value.slice(0, head), ...preview.options };
  }
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const location = value.slice(0, at);
  const q = location.indexOf("?");
  if (q === -1) return parseDraftPointer(value) === null ? null : { version: value };
  const preview = liftPreview(location.slice(q + 1));
  if (preview === null) return null;
  const query = preview.kept.length === 0 ? "" : `?${preview.kept.join("&")}`;
  const version = `${location.slice(0, q)}${query}${value.slice(at)}`;
  return parseDraftPointer(version) === null ? null : { version, ...preview.options };
}

/** A query's preview parameters, read, and the other parameters, kept as they are. */
function liftPreview(query: string): {
  kept: string[];
  options: Omit<RequestVersion, "version">;
} | null {
  const kept: string[] = [];
  let at: string | undefined;
  let experiments: Assignments | undefined;
  let campaigns: Assignments | undefined;
  for (const param of query.split("&")) {
    if (param.startsWith(AT_PARAM)) {
      const value = decodeParam(param.slice(AT_PARAM.length));
      if (at !== undefined || value === null || !AT_RE.test(value)) return null;
      if (Number.isNaN(Date.parse(value))) return null;
      at = value;
    } else if (param.startsWith(TEST_PARAM)) {
      const test = decodeSwitch(param.slice(TEST_PARAM.length));
      if (test === null) return null;
      experiments ??= Object.create(null) as Assignments;
      experiments[test.name] = test.on;
    } else if (param.startsWith(CAMPAIGN_PARAM)) {
      const campaign = decodeSwitch(param.slice(CAMPAIGN_PARAM.length));
      if (campaign === null) return null;
      campaigns ??= Object.create(null) as Assignments;
      campaigns[campaign.name] = campaign.on;
    } else if (param !== "") {
      kept.push(param);
    }
  }
  const options: Omit<RequestVersion, "version"> = {};
  if (at !== undefined) options.date = new Date(Date.parse(at));
  if (experiments !== undefined) options.experiments = experiments;
  if (campaigns !== undefined) options.campaigns = campaigns;
  return { kept, options };
}

/**
 * Parses a pointer, strictly: `null` on a scheme, a stray `@`, an unrooted
 * path, an odd character in the host or version, a port out of range, or a
 * preview link's `__at`, `__test` or `__campaign` left in its query (they
 * aren't part of a version: `parseVersion` lifts them out). The host is
 * lowercased (DNS names are case-insensitive); path and version are kept as
 * they are.
 */
export function parseDraftPointer(raw: string | null | undefined): DraftPointer | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_POINTER_LENGTH) return null;
  const at = raw.lastIndexOf("@");
  if (at <= 0) return null;
  const version = raw.slice(at + 1);
  if (!VERSION_RE.test(version)) return null;

  const location = raw.slice(0, at);
  const slash = location.indexOf("/");
  if (slash <= 0) return null;
  const path = location.slice(slash);
  if (!PATH_RE.test(path) || path.startsWith("//")) return null;

  const host = normalizeHost(location.slice(0, slash));
  if (host === null) return null;
  const split = splitVariants(path);
  if (split === null) return null;
  const pointer: DraftPointer = { host, path: split.path, version };
  if (split.variants.length > 0) pointer.variants = split.variants;
  return pointer;
}

/**
 * Builds a pointer from its parts: the inverse of {@link parseDraftPointer}.
 * Throws a `TypeError` when the parts can't form a pointer that parses, so a
 * bad pointer is caught where it's built rather than where it's loaded.
 */
export function formatDraftPointer(pointer: DraftPointer): string {
  const variants = pointer.variants ?? [];
  const params = variants.map((variant) => VARIANT_PARAM + encodeVariant(variant));
  const path =
    params.length === 0
      ? pointer.path
      : `${pointer.path}${pointer.path.includes("?") ? "&" : "?"}${params.join("&")}`;
  const parsed = parseDraftPointer(`${pointer.host}${path}@${pointer.version}`);
  if (
    parsed === null ||
    parsed.path !== pointer.path ||
    parsed.version !== pointer.version ||
    JSON.stringify(parsed.variants ?? []) !== JSON.stringify(variants.map(plainVariant))
  ) {
    throw new TypeError(`invalid draft pointer parts: ${JSON.stringify(pointer)}`);
  }
  return `${parsed.host}${path}@${parsed.version}`;
}

/**
 * The path without its `__variant` parameters, and the variants they force.
 * `null` on one that doesn't parse, or on a preview link's `__at`, `__test`
 * or `__campaign`.
 */
function splitVariants(path: string): { path: string; variants: ForcedVariant[] } | null {
  const q = path.indexOf("?");
  if (q === -1) return { path, variants: [] };
  const kept: string[] = [];
  const variants: ForcedVariant[] = [];
  for (const param of path.slice(q + 1).split("&")) {
    if (param.startsWith(VARIANT_PARAM)) {
      const variant = decodeVariant(param.slice(VARIANT_PARAM.length));
      if (variant === null) return null;
      variants.push(variant);
    } else if (PREVIEW_PARAMS.some((prefix) => param.startsWith(prefix))) {
      return null;
    } else {
      kept.push(param);
    }
  }
  const base = path.slice(0, q);
  return { path: kept.length === 0 ? base : `${base}?${kept.join("&")}`, variants };
}

/** `<name>=on|off`: the state after the last `=`, the test's or campaign's name before it. */
function decodeSwitch(encoded: string): { name: string; on: boolean } | null {
  const raw = decodeParam(encoded);
  if (raw === null) return null;
  const eq = raw.lastIndexOf("=");
  const state = raw.slice(eq + 1);
  if (eq <= 0 || (state !== "on" && state !== "off")) return null;
  return { name: raw.slice(0, eq), on: state === "on" };
}

function decodeParam(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** `<block>@<path>=<index>`: the index after the last `=`, the block before the last `@`. */
function decodeVariant(encoded: string): ForcedVariant | null {
  let raw: string;
  try {
    raw = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const eq = raw.lastIndexOf("=");
  const at = raw.lastIndexOf("@", eq);
  if (eq === -1 || at <= 0) return null;
  const index = raw.slice(eq + 1);
  const path = raw.slice(at + 1, eq);
  if (!INDEX_RE.test(index) || (path !== "" && path.split(".").includes(""))) return null;
  return { block: raw.slice(0, at), path, index: Number(index) };
}

function encodeVariant({ block, path, index }: ForcedVariant): string {
  return encodeParam(`${block}@${path}=${index}`);
}

function encodeParam(value: string): string {
  // encodeURIComponent leaves !'()* as they are; the pointer's path doesn't allow them.
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function plainVariant({ block, path, index }: ForcedVariant): ForcedVariant {
  return { block, path, index };
}

function normalizeHost(authority: string): string | null {
  if (authority.startsWith("[")) return normalizeIPv6Host(authority);
  const parts = authority.toLowerCase().split(":");
  if (parts.length > 2) return null;
  const [host, port] = parts;
  if (!host || !HOST_RE.test(host)) return null;
  if (port === undefined) return host;
  if (!PORT_RE.test(port) || Number(port) > 65535) return null;
  return `${host}:${port}`;
}

/** `[addr]` or `[addr]:port`, the address in the compressed, lowercase form a URL gives it. */
function normalizeIPv6Host(authority: string): string | null {
  const end = authority.indexOf("]");
  const address = authority.slice(0, end + 1);
  const rest = authority.slice(end + 1);
  if (end === -1 || !/^\[[0-9a-fA-F:.]+\]$/.test(address)) return null;
  if (rest !== "" && (!rest.startsWith(":") || !PORT_RE.test(rest.slice(1)))) return null;
  if (rest !== "" && Number(rest.slice(1)) > 65535) return null;
  let host: string;
  try {
    host = new URL(`http://${address}/`).hostname;
  } catch {
    return null;
  }
  return `${host}${rest}`;
}

/**
 * The version a request carries (a draft pointer, or a published release's
 * commit SHA) with its preview's date, tests and campaigns (`parseVersion`):
 * `?__draft=` from the URL first, then the `__deco_draft`
 * cookie. `null` when neither is present, or when the URL says
 * `?__draft=off`. A value that doesn't parse is ignored, as if it were
 * absent: a stray `?__draft=junk` link or a mangled cookie gets the release,
 * never an error from `cms.client`.
 */
export function readVersion(request: RequestLike): RequestVersion | null {
  const param = draftParam(request);
  if (param === DRAFT_OFF) return null;
  const fromLink = param ? parseVersion(param) : null;
  if (fromLink !== null) return fromLink;
  return parseVersion(readCookie(request.headers.get("cookie"), DRAFT_COOKIE));
}

/**
 * The `Set-Cookie` value for a request whose URL carries `?__draft=`: one that
 * stores the version (a draft pointer or a release's commit SHA), or one that expires the cookie when the value is `off`
 * (how the site editor ends a preview). `null` on every other request, and for
 * a pointer that doesn't parse, so garbage never lands in the cookie.
 *
 * The site editor previews your site inside a cross-site iframe, so the cookie
 * is `Secure; SameSite=None; Partitioned` (CHIPS): `SameSite=Lax` would never
 * be sent there. `HttpOnly` keeps page scripts from reading the pointer.
 */
export function draftCookieFor(request: RequestLike): string | null {
  const param = draftParam(request);
  if (!param) return null;
  if (param === DRAFT_OFF) return serializeCookie("", ["Max-Age=0"]);
  if (parseVersion(param) === null) return null;
  return serializeCookie(encodeURIComponent(param), []);
}

/** Whether the request's URL says `?__draft=off`: the cookie that ends a preview is set on any host. */
export function endsPreview(request: RequestLike): boolean {
  return draftParam(request) === DRAFT_OFF;
}

function serializeCookie(value: string, extra: string[]): string {
  return [
    `${DRAFT_COOKIE}=${value}`,
    "Path=/",
    ...extra,
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Partitioned",
  ].join("; ");
}

function draftParam(request: RequestLike): string | null {
  try {
    return new URL(request.url, "http://localhost").searchParams.get(DRAFT_PARAM);
  } catch {
    return null;
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}
