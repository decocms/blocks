/**
 * Cookie jar for a React Native client.
 *
 * The site keeps session state entirely in cookies — nothing is mirrored into
 * a response body, and no invoke response carries an explicit session handle.
 * A browser's cookie jar makes that invisible. React Native has no jar, and its
 * `fetch` is the `whatwg-fetch` polyfill, whose `Headers`:
 *
 *   - has **no `getSetCookie()`**, and
 *   - collapses repeated headers by joining them: `old + ", " + value`.
 *
 * So a response setting five cookies (a normal VTEX cart round-trip:
 * `checkout.vtex.com__orderFormId`, `CheckoutOrderFormOwnership`, `segment`,
 * `sc`, `vtex_session`) arrives as one comma-joined string. Splitting it on
 * `,` naively corrupts every cookie carrying a date, because `Expires` values
 * contain a comma: `Expires=Wed, 21 Oct 2025 07:28:00 GMT`.
 *
 * This is the client-side twin of the bug `forwardCtxHeadersTo`
 * (`@decocms/blocks-admin`) was written to fix on the server, and its comment
 * describes the outcome: the user lands on checkout with an empty cart.
 *
 * ponytail: this is NOT an RFC 6265 jar. An app talks to one storefront
 * origin, so `Domain`/`Path` matching, host-only flags, `Secure`, `HttpOnly`
 * and public-suffix rules are all skipped — every cookie is stored flat and
 * sent to that one origin. Add scoping if an app ever talks to two origins.
 */

/** Async-or-sync KV. `@react-native-async-storage/async-storage` fits as-is. */
export interface CookieStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

interface StoredCookie {
  value: string;
  /** Epoch ms. `undefined` = session cookie, kept until the jar is cleared. */
  expires?: number;
}

/**
 * Splits a comma-joined `Set-Cookie` header back into individual cookies.
 *
 * A comma starts a new cookie only when what follows looks like `name=`
 * before the next `;` or `,`. Inside `Expires=Wed, 21 Oct 2025 ...` the text
 * after the comma has no `=`, so it stays attached — which is the whole point.
 */
export function splitSetCookie(header: string): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < header.length; i++) {
    if (header[i] !== ",") continue;

    // Look ahead: a new cookie iff `name=` appears before the next `;` or `,`.
    const rest = header.slice(i + 1);
    const boundary = rest.search(/[;,]/);
    const segment = boundary === -1 ? rest : rest.slice(0, boundary);
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;

    const name = segment.slice(0, eq).trim();
    // Cookie names are tokens: no spaces, no separators.
    if (!name || /[\s()<>@,;:\\"/[\]?={}]/.test(name)) continue;

    out.push(header.slice(start, i).trim());
    start = i + 1;
  }

  const tail = header.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/**
 * Reads every `Set-Cookie` off a response, whichever API the runtime offers.
 *
 * Both sources are run through {@link splitSetCookie}, including `getSetCookie`.
 * That is not belt-and-braces: `getSetCookie()` returns whatever the header
 * store holds, and a store that was populated with an already-joined value
 * hands back a single element containing all five cookies — indistinguishable
 * from one real cookie. Splitting is idempotent for a well-formed single
 * cookie, so running it always is strictly safer than trusting the shape.
 */
export function readSetCookies(headers: Headers): string[] {
  // Node 18.14+, Workers, and modern browsers keep them separate.
  const native = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  const values =
    typeof native === "function" ? native.call(headers) : [headers.get("set-cookie") ?? ""];

  return values.filter(Boolean).flatMap(splitSetCookie);
}

/** Parses one `Set-Cookie` value. Returns null for a malformed one. */
function parseSetCookie(raw: string): { name: string; cookie: StoredCookie } | null {
  const [pair, ...attrs] = raw.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  let expires: number | undefined;
  for (const attr of attrs) {
    const sep = attr.indexOf("=");
    const key = (sep === -1 ? attr : attr.slice(0, sep)).trim().toLowerCase();
    const val = sep === -1 ? "" : attr.slice(sep + 1).trim();

    // Max-Age wins over Expires per RFC 6265, and is what most APIs send.
    if (key === "max-age") {
      const seconds = Number(val);
      if (Number.isFinite(seconds)) expires = Date.now() + seconds * 1000;
    } else if (key === "expires" && expires === undefined) {
      const parsed = Date.parse(val);
      if (!Number.isNaN(parsed)) expires = parsed;
    }
  }

  return { name, cookie: { value, expires } };
}

export interface CookieJarOptions {
  /** Persist across launches. Omit for an in-memory jar. */
  storage?: CookieStorage;
  /** Storage key. Give each storefront its own if an app ships several. */
  storageKey?: string;
}

export function createCookieJar(options: CookieJarOptions = {}) {
  const { storage, storageKey = "deco.cookies" } = options;
  let jar = new Map<string, StoredCookie>();
  let hydrated = !storage;

  const persist = () => {
    if (!storage) return;
    // Fire-and-forget: a failed write costs a session, never a request.
    void Promise.resolve(
      storage.setItem(storageKey, JSON.stringify(Object.fromEntries(jar))),
    ).catch(() => {});
  };

  /** Loads persisted cookies once. Safe to call on every request. */
  async function hydrate(): Promise<void> {
    if (hydrated) return;
    hydrated = true;
    try {
      const raw = await storage?.getItem(storageKey);
      if (raw) jar = new Map(Object.entries(JSON.parse(raw) as Record<string, StoredCookie>));
    } catch {
      // Corrupt payload — start clean rather than wedge every request.
    }
  }

  const isLive = (cookie: StoredCookie) =>
    cookie.expires === undefined || cookie.expires > Date.now();

  /** Applies a response's `Set-Cookie` headers. Returns the names it touched. */
  function apply(headers: Headers): string[] {
    const touched: string[] = [];
    for (const raw of readSetCookies(headers)) {
      const parsed = parseSetCookie(raw);
      if (!parsed) continue;
      // An expired cookie is a deletion — that is how logout works.
      if (parsed.cookie.expires !== undefined && parsed.cookie.expires <= Date.now()) {
        jar.delete(parsed.name);
      } else {
        jar.set(parsed.name, parsed.cookie);
      }
      touched.push(parsed.name);
    }
    if (touched.length > 0) persist();
    return touched;
  }

  /** The `Cookie:` header value, or `undefined` when the jar is empty. */
  function header(): string | undefined {
    const parts: string[] = [];
    for (const [name, cookie] of jar) {
      if (isLive(cookie)) parts.push(`${name}=${cookie.value}`);
      else jar.delete(name);
    }
    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  function clear(): void {
    jar.clear();
    if (storage) void Promise.resolve(storage.removeItem(storageKey)).catch(() => {});
  }

  return {
    hydrate,
    apply,
    header,
    clear,
    get size() {
      return jar.size;
    },
  };
}

export type CookieJar = ReturnType<typeof createCookieJar>;

/**
 * Wraps `fetch` so every request carries the jar's cookies and every response
 * feeds it back. This is the seam `createAppInvokeWith({ fetcher })` and
 * `createRenderJsonClient({ fetcher })` both accept, so a single jar covers
 * page loads and invoke calls — which matters, because a cart cookie set by an
 * invoke must be visible to the next `?renderJson`.
 *
 * Requires **no server change**.
 */
export function withCookieJar(jar: CookieJar, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    await jar.hydrate();

    const headers = new Headers(init?.headers);
    const cookie = jar.header();
    // An explicit Cookie on the call wins — the caller knows something we do not.
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);

    const response = await fetcher(input, { ...init, headers });
    jar.apply(response.headers);
    return response;
  };
}
