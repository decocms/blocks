/**
 * Draft pointers (see /next/api-reference#draft-pointers): the string
 * `<host[:port]><path[?query]>@<version>` that names a draft, and the two
 * helpers that carry one from a `?__draft=` link into a cookie.
 */
import type { DraftPointer } from "./types.ts";

/** The draft cookie's name, for frameworks whose cookie API has no Request (Next.js `cookies()`). */
export const DRAFT_COOKIE = "deco-draft";

const DRAFT_PARAM = "__draft";
const DRAFT_OFF = "off";

/** Lowercase DNS name; a single label (`localhost`) is allowed. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const PORT_RE = /^[0-9]{1,5}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Rooted path with an optional query; no `@`, `#`, whitespace or scheme characters. */
const PATH_RE = /^\/[A-Za-z0-9/_.%~=&?-]*$/;
const MAX_POINTER_LENGTH = 4096;

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
  return host === null ? null : { host, path, version };
}

/**
 * Builds a pointer from its parts: the inverse of {@link parseDraftPointer}.
 * Throws a `TypeError` when the parts can't form a pointer that parses, so a
 * bad pointer is caught where it's built rather than where it's loaded.
 */
export function formatDraftPointer(pointer: DraftPointer): string {
  const raw = `${pointer.host}${pointer.path}@${pointer.version}`;
  const parsed = parseDraftPointer(raw);
  if (parsed === null || parsed.path !== pointer.path || parsed.version !== pointer.version) {
    throw new TypeError(`invalid draft pointer parts: ${JSON.stringify(pointer)}`);
  }
  return `${parsed.host}${parsed.path}@${parsed.version}`;
}

function normalizeHost(authority: string): string | null {
  const parts = authority.toLowerCase().split(":");
  if (parts.length > 2) return null;
  const [host, port] = parts;
  if (!host || !HOST_RE.test(host)) return null;
  if (port === undefined) return host;
  if (!PORT_RE.test(port) || Number(port) > 65535) return null;
  return `${host}:${port}`;
}

/** Anything with a `url` and `headers`: a fetch `Request`, a `NextRequest`, a framework wrapper. */
export type RequestLike = Request | { url: string; headers: Headers };

/**
 * The draft pointer a request carries: `?__draft=` from the URL first, then
 * the `deco-draft` cookie. `null` when neither is present, or when the URL
 * says `?__draft=off`. The value is returned as is; `cms.forDraft` validates it.
 */
export function draftPointer(request: RequestLike): string | null {
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
export function draftCookie(request: RequestLike): string | null {
  const param = draftParam(request);
  if (!param) return null;
  if (param === DRAFT_OFF) return serializeCookie("", ["Max-Age=0"]);
  if (parseDraftPointer(param) === null) return null;
  return serializeCookie(encodeURIComponent(param), []);
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
