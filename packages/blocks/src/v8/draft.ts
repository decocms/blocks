/**
 * Draft pointers (see /next/api-reference#draft-pointers): the string
 * `<host[:port]><path[?query]>@<version>` that names a draft, and what
 * `cms.readVersion` and `cms.draftCookie` read and write to carry one (or a
 * published release's commit SHA) from a `?__draft=` link into a cookie. The
 * host check against the preview hosts is
 * the CMS's: these read the request only.
 *
 * The query's reserved parameters are what a Studio preview sets, lifted out
 * of `path` by the parser:
 *
 * - `__variant=<block>@<path>=<index>`: a variant the preview forces, one per
 *   multivariate (`variants`).
 * - `__at=<ISO date-time with offset>`: the moment the preview shows
 *   (`at`), which becomes `client.now`.
 * - `__test=<name>=on|off`: an A/B test the preview forces on or off
 *   (`tests`), applied by `split-traffic` over the visitor's answer.
 *
 * Each value is URL-encoded. A published release's commit SHA carries the
 * same parameters after a `?`: `<sha>?__at=…&__test=…`.
 */
import type { DraftPointer, ForcedVariant, RequestLike } from "./types.ts";

/** What a preview link sets besides the version: forced variants, a moment, forced tests. */
type Preview = Pick<DraftPointer, "variants" | "at" | "tests">;

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
/** An ISO 8601 date-time with its offset (`Z` or `±hh:mm`): the moment a preview shows. */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const INDEX_RE = /^(0|[1-9][0-9]{0,3})$/;
/** A published release: its git commit SHA (SHA-1, 40 lowercase hex). */
const REVISION_RE = /^[0-9a-f]{40}$/;

/** A version, parsed: a published release (by its commit SHA) or a draft, each with its preview. */
type ParsedVersion =
  | { kind: "revision"; sha: string; preview: Preview }
  | { kind: "draft"; pointer: DraftPointer; preview: Preview };

/**
 * Parses a version: a published release's commit SHA (40 lowercase hex),
 * optionally followed by `?` and the preview parameters, or a draft pointer.
 * `null` for anything else.
 */
export function parseVersion(value: string): ParsedVersion | null {
  const q = value.indexOf("?");
  const sha = q === -1 ? value : value.slice(0, q);
  if (REVISION_RE.test(sha)) {
    if (q === -1) return { kind: "revision", sha, preview: {} };
    const split = splitPreview(`/${value.slice(q)}`);
    if (split === null || split.path !== "/") return null;
    return { kind: "revision", sha, preview: previewOf(split) };
  }
  const pointer = parseDraftPointer(value);
  return pointer === null ? null : { kind: "draft", pointer, preview: previewOf(pointer) };
}

/** Whether a Studio link's value is a version: a draft pointer or a release's commit SHA. */
function isVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

function previewOf({ variants, at, tests }: Preview): Preview {
  const preview: Preview = {};
  if (variants !== undefined && variants.length > 0) preview.variants = variants;
  if (at !== undefined) preview.at = at;
  if (tests !== undefined) preview.tests = tests;
  return preview;
}

/**
 * Parses a pointer, strictly: `null` on a scheme, a stray `@`, an unrooted
 * path, an odd character in the host or version, or a port out of range. The
 * host is lowercased (DNS names are case-insensitive); path and version are
 * kept as they are.
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
  const split = splitPreview(path);
  if (split === null) return null;
  return { host, path: split.path, version, ...previewOf(split) };
}

/**
 * Builds a pointer from its parts: the inverse of {@link parseDraftPointer}.
 * Throws a `TypeError` when the parts can't form a pointer that parses, so a
 * bad pointer is caught where it's built rather than where it's loaded.
 */
export function formatDraftPointer(pointer: DraftPointer): string {
  const variants = pointer.variants ?? [];
  const tests = pointer.tests ?? {};
  const params = [
    ...variants.map((variant) => VARIANT_PARAM + encodeVariant(variant)),
    ...(pointer.at === undefined ? [] : [AT_PARAM + encodeParam(pointer.at)]),
    ...Object.keys(tests).map(
      (name) => TEST_PARAM + encodeParam(`${name}=${tests[name] === true ? "on" : "off"}`),
    ),
  ];
  const path =
    params.length === 0
      ? pointer.path
      : `${pointer.path}${pointer.path.includes("?") ? "&" : "?"}${params.join("&")}`;
  const parsed = parseDraftPointer(`${pointer.host}${path}@${pointer.version}`);
  if (
    parsed === null ||
    parsed.path !== pointer.path ||
    parsed.version !== pointer.version ||
    JSON.stringify(parsed.variants ?? []) !== JSON.stringify(variants.map(plainVariant)) ||
    parsed.at !== pointer.at ||
    JSON.stringify(parsed.tests ?? {}) !== JSON.stringify(plainTests(tests))
  ) {
    throw new TypeError(`invalid draft pointer parts: ${JSON.stringify(pointer)}`);
  }
  return `${parsed.host}${path}@${parsed.version}`;
}

/**
 * The path without its preview parameters, and what they set: the variants
 * (`__variant`), the moment (`__at`) and the tests (`__test`; the last one
 * for a name wins). `null` on one that doesn't parse, or a second `__at`.
 */
function splitPreview(
  path: string,
): (Preview & { path: string; variants: ForcedVariant[] }) | null {
  const q = path.indexOf("?");
  if (q === -1) return { path, variants: [] };
  const kept: string[] = [];
  const variants: ForcedVariant[] = [];
  let at: string | undefined;
  let tests: Record<string, boolean> | undefined;
  for (const param of path.slice(q + 1).split("&")) {
    if (param.startsWith(VARIANT_PARAM)) {
      const variant = decodeVariant(param.slice(VARIANT_PARAM.length));
      if (variant === null) return null;
      variants.push(variant);
    } else if (param.startsWith(AT_PARAM)) {
      const value = decodeParam(param.slice(AT_PARAM.length));
      if (at !== undefined || value === null || !AT_RE.test(value)) return null;
      if (Number.isNaN(Date.parse(value))) return null;
      at = value;
    } else if (param.startsWith(TEST_PARAM)) {
      const test = decodeTest(param.slice(TEST_PARAM.length));
      if (test === null) return null;
      tests ??= Object.create(null) as Record<string, boolean>;
      tests[test.name] = test.on;
    } else {
      kept.push(param);
    }
  }
  const base = path.slice(0, q);
  return {
    path: kept.length === 0 ? base : `${base}?${kept.join("&")}`,
    variants,
    ...(at === undefined ? {} : { at }),
    ...(tests === undefined ? {} : { tests }),
  };
}

/** `<name>=on|off`: the state after the last `=`, the test's name before it. */
function decodeTest(encoded: string): { name: string; on: boolean } | null {
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

/** The tests as the parser gives them back: in order, each `true` or `false`. */
function plainTests(tests: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.keys(tests).map((name) => [name, tests[name] === true]));
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
 * commit SHA): `?__draft=` from the URL first, then the `__deco_draft`
 * cookie. `null` when neither is present, or when the URL says
 * `?__draft=off`. A value that doesn't parse is ignored, as if it were
 * absent: a stray `?__draft=junk` link or a mangled cookie gets the release,
 * never an error from `cms.client`.
 */
export function readVersion(request: RequestLike): string | null {
  const param = draftParam(request);
  if (param === DRAFT_OFF) return null;
  if (param && isVersion(param)) return param;
  const cookie = readCookie(request.headers.get("cookie"), DRAFT_COOKIE);
  return cookie && isVersion(cookie) ? cookie : null;
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
  if (!isVersion(param)) return null;
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
