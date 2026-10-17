/** Set-Cookie handling: which cookies a cached response may carry, and one header per cookie. */

function cookieName(setCookie: string): string {
  const eq = setCookie.indexOf("=");
  return eq > 0 ? setCookie.slice(0, eq).trim() : "";
}

/** Whether every cookie the response sets is one a shared (cached) response may set. */
export function hasOnlySafeCookies(response: Response, safe: ReadonlySet<string>): boolean {
  return response.headers.getSetCookie().every((c) => {
    const name = cookieName(c);
    return name === "" || safe.has(name);
  });
}

/** A copy for the cache without the safe cookies; the visitor still gets them. */
export function withoutSafeCookies(response: Response, safe: ReadonlySet<string>): Response {
  const copy = response.clone();
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return copy;
  copy.headers.delete("set-cookie");
  for (const c of cookies) {
    const name = cookieName(c);
    if (name && !safe.has(name)) copy.headers.append("set-cookie", c);
  }
  return copy;
}

/**
 * A Set-Cookie's identity: name + Domain + Path, the way the browser keys its
 * cookie jar (RFC 6265 §5.3), so two headers that differ in scope address two
 * cookies. The domain is case-insensitive and a leading dot is ignored; the
 * path is compared as sent. v7's #642.
 */
export function setCookieIdentity(setCookie: string): string {
  const [nameValue = "", ...attrs] = setCookie.split(";");
  const eq = nameValue.indexOf("=");
  const name = eq > 0 ? nameValue.slice(0, eq).trim() : nameValue.trim();
  let domain = "";
  let path = "";
  for (const attr of attrs) {
    const sep = attr.indexOf("=");
    const key = (sep >= 0 ? attr.slice(0, sep) : attr).trim().toLowerCase();
    const value = sep >= 0 ? attr.slice(sep + 1).trim() : "";
    if (key === "domain") domain = value.replace(/^\./, "").toLowerCase();
    else if (key === "path") path = value;
  }
  return `${name}\u0000${domain}\u0000${path}`;
}

/**
 * Keeps the last Set-Cookie of each cookie (name + Domain + Path): several
 * layers may set the same cookie. Keying on the name alone would collapse a
 * sign-out that clears one cookie under several scopes into a single clear,
 * leaving the others signed in. The response's headers must be mutable.
 */
export function dedupeSetCookies(response: Response): void {
  const cookies = response.headers.getSetCookie();
  if (cookies.length <= 1) return;
  const last = new Map<string, string>();
  for (const c of cookies) last.set(setCookieIdentity(c), c);
  if (last.size === cookies.length) return;
  response.headers.delete("set-cookie");
  for (const c of last.values()) response.headers.append("set-cookie", c);
}
