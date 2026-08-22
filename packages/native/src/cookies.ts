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

/**
 * The device's own cookie store — the one a WebView writes into.
 *
 * This exists because a hybrid app has TWO cookie stores and nothing joins
 * them. `fetch` from native code uses this jar; a `<WebView>` uses the
 * platform store (`NSHTTPCookieStorage` on iOS with `sharedCookiesEnabled`,
 * the `CookieManager` on Android). So an item added to the cart on a page
 * inside the WebView lands in a DIFFERENT cart from the one a native screen
 * reads — with no error anywhere. The native badge just never moves.
 *
 * Implement with `@react-native-cookies/cookies`:
 *
 * ```ts
 * import CookieManager from "@react-native-cookies/cookies";
 * const system: SystemCookieStore = {
 *   get: (url) => CookieManager.get(url).then((all) =>
 *     Object.fromEntries(Object.entries(all).map(([k, c]) => [k, c.value]))),
 *   set: (url, cookie) => CookieManager.setFromResponse(url, cookie).then(() => {}),
 * };
 * ```
 *
 * Injected rather than depended on: the package must stay installable in an
 * app with no WebView, and the native module is a build-time cost.
 */
export interface SystemCookieStore {
  /** Cookies the platform store holds for `url`, as name → value. */
  get(url: string): Promise<Record<string, string>> | Record<string, string>;
  /** Writes one raw `Set-Cookie` value into the platform store. */
  set(url: string, setCookie: string): Promise<void> | void;
}

export interface CookieJarOptions {
  /** Persist across launches. Omit for an in-memory jar. */
  storage?: CookieStorage;
  /** Storage key. Give each storefront its own if an app ships several. */
  storageKey?: string;
  /**
   * Share the session with the WebView. Omit and the two stay separate — which
   * is the default only because the native module is optional, not because it
   * is a sane default for a hybrid app.
   */
  system?: SystemCookieStore;
  /** Origin the system store is scoped to. Required with `system`. */
  systemUrl?: string;
}

export function createCookieJar(options: CookieJarOptions = {}) {
  const { storage, storageKey = "deco.cookies", system, systemUrl } = options;
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
    const raws = readSetCookies(headers);
    // Mirror into the platform store so the WebView sees the same session.
    // Fire-and-forget on purpose: a failed mirror must not fail the request
    // that already succeeded.
    if (system && systemUrl) {
      for (const raw of raws) {
        try {
          void Promise.resolve(system.set(systemUrl, raw)).catch(() => {});
        } catch {
          // Um módulo nativo pode lançar de forma SÍNCRONA, e aí o
          // `Promise.resolve(...)` nem chega a embrulhar — sem este try a
          // ponte quebrada derruba a resposta que já tinha dado certo.
        }
      }
    }
    const touched: string[] = [];
    for (const raw of raws) {
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

  /**
   * Pulls the platform store into the jar.
   *
   * The direction that matters most: the WebView is where checkout, login and
   * any un-ported page live, so it is usually the one that MOVED the session.
   * Called before each request rather than once at boot, because the WebView
   * can change it at any moment.
   */
  async function syncFromSystem(): Promise<void> {
    if (!system || !systemUrl) return;
    try {
      const current = await system.get(systemUrl);
      for (const [name, value] of Object.entries(current)) {
        // The platform store wins: it is the shared surface, and a stale jar
        // entry is exactly the bug this method exists to fix.
        jar.set(name, { value });
      }
    } catch {
      // No native module, or the store refused. Fall back to the local jar.
    }
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
    syncFromSystem,
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
    // Pull whatever the WebView did since the last call. Without this the two
    // surfaces drift into separate carts: you add on a page inside the WebView
    // and the native badge never moves, with no error to follow.
    await jar.syncFromSystem();

    const headers = new Headers(init?.headers);
    const cookie = jar.header();
    // An explicit Cookie on the call wins — the caller knows something we do not.
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);

    const response = await fetcher(input, { ...init, headers });
    jar.apply(response.headers);
    return response;
  };
}
