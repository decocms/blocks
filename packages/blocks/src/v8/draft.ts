/**
 * Draft pointers (see /next/api-reference#draft-pointers): the string
 * `<host[:port]><path[?query]>@<version>` that names a draft, and what
 * `cms.draftPointer` and `cms.draftCookie` read and write to carry one from a
 * `?__draft=` link into a cookie. The host check against the preview hosts is
 * the CMS's: these read the request only.
 *
 * The query's reserved `__variant` parameters are the variants a preview
 * forces (`<block>@<path>=<index>`, URL-encoded, one per multivariate); the
 * parser lifts them out of `path` into `variants`.
 */
import type { DraftPointer, ForcedVariant, RequestLike } from "./types.ts";

/** The draft cookie's name. Not exported from the package: reading it directly would skip the host check. */
const DRAFT_COOKIE = "__deco_draft";

const DRAFT_PARAM = "__draft";
const DRAFT_OFF = "off";

/** Lowercase DNS name; a single label (`localhost`) is allowed. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const PORT_RE = /^[0-9]{1,5}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Rooted path with an optional query; no `@`, `#`, whitespace or scheme characters. */
const PATH_RE = /^\/[A-Za-z0-9/_.%~=&?-]*$/;
const MAX_POINTER_LENGTH = 4096;
const VARIANT_PARAM = "__variant=";
const INDEX_RE = /^(0|[1-9][0-9]{0,3})$/;

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
  const split = splitVariants(path);
  if (split === null) return null;
  return split.variants.length === 0
    ? { host, path, version }
    : { host, path: split.path, version, variants: split.variants };
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

/** The path without its `__variant` parameters, and the variants they force; `null` on a bad one. */
function splitVariants(path: string): { path: string; variants: ForcedVariant[] } | null {
  const q = path.indexOf("?");
  if (q === -1) return { path, variants: [] };
  const kept: string[] = [];
  const variants: ForcedVariant[] = [];
  for (const param of path.slice(q + 1).split("&")) {
    if (!param.startsWith(VARIANT_PARAM)) {
      kept.push(param);
      continue;
    }
    const variant = decodeVariant(param.slice(VARIANT_PARAM.length));
    if (variant === null) return null;
    variants.push(variant);
  }
  const base = path.slice(0, q);
  return { path: kept.length === 0 ? base : `${base}?${kept.join("&")}`, variants };
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
  // encodeURIComponent leaves !'()* as they are; the pointer's path doesn't allow them.
  return encodeURIComponent(`${block}@${path}=${index}`).replace(
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
 * The draft pointer a request carries: `?__draft=` from the URL first, then
 * the `__deco_draft` cookie. `null` when neither is present, or when the URL
 * says `?__draft=off`. The value is returned as is; `cms.forDraft` validates it.
 */
export function readDraftPointer(request: RequestLike): string | null {
  const param = draftParam(request);
  if (param === DRAFT_OFF) return null;
  if (param) return param;
  const cookie = readCookie(request.headers.get("cookie"), DRAFT_COOKIE);
  return cookie && cookie !== DRAFT_OFF ? cookie : null;
}

/**
 * The `Set-Cookie` value for a request whose URL carries `?__draft=`: one that
 * stores the pointer, or one that expires the cookie when the value is `off`
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
  if (parseDraftPointer(param) === null) return null;
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
