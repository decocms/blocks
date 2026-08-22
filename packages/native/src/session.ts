/**
 * Decides who owns the session cookie, and gets out of the way when the
 * platform already does.
 *
 * This module exists because the obvious design is wrong in a way that is very
 * hard to see. A React Native `fetch` looks jar-less, so the instinct is to add
 * one — and on iOS/Android that jar does not just duplicate the platform, it
 * **corrupts the session**:
 *
 * 1. The jar sends its own `Cookie: cart=<value>` header.
 * 2. The server reads it, and echoes the same value back in a `Set-Cookie`.
 * 3. The native networking layer stores that response cookie.
 * 4. Next request, the jar sends the stored value — now with the previous one
 *    appended, because the two `Set-Cookie` values were joined on a `,`.
 *
 * The value grows every round trip. Measured on a real device build going
 * 1190 → 2390 bytes with `,cart=` repeated inside; at that point Shopify stops
 * recognising the id and opens a fresh cart on every call. The symptom is
 * "added to cart, but the bag is empty" — with a `200` on every request and
 * nothing in any log.
 *
 * ## The platform already shares the session
 *
 * On iOS, `fetch` goes through `NSURLSession`, which persists cookies in
 * `NSHTTPCookieStorage` — and `<WebView sharedCookiesEnabled>` uses that same
 * store. On Android, RN's networking uses `ForwardingCookieHandler`, which
 * wraps the very `android.webkit.CookieManager` the WebView uses.
 *
 * So on both, native screens and embedded pages are already one session. An
 * item added on a page inside the WebView is in the cart a native screen reads,
 * with no bridge, no native module, and no jar.
 *
 * The jar earns its place only where nothing persists cookies for us — Expo
 * web, or a custom fetch. There it is the difference between having a cart and
 * not having one.
 */

import { type CookieJar, type CookieStorage, createCookieJar, withCookieJar } from "./cookies";

export interface NativeSessionOptions {
  /** Persists the jar across launches. Only used when the jar is in play. */
  storage?: CookieStorage;
  /** Underlying transport. */
  fetcher?: typeof fetch;
  /**
   * Force a strategy instead of detecting one.
   *
   * `"platform"` — trust the OS cookie store (ios/android).
   * `"jar"` — always use the in-memory jar. Useful in tests, and on a target
   * where you know `fetch` does not persist cookies.
   */
  strategy?: "platform" | "jar";
}

export interface NativeSession {
  /** Pass to `createRenderJsonClient`. */
  fetcher: typeof fetch;
  /**
   * The jar, or `undefined` when the platform owns cookies. Pass straight to
   * `createNativeInvoke`'s `jar` — it takes `false` for "platform owns it", so
   * `jar: session.jar ?? false` is the whole wiring.
   */
  jar?: CookieJar;
  /** True when the OS store is authoritative and both surfaces share it. */
  platformManaged: boolean;
}

/**
 * True when the running platform persists cookies AND shares them with a
 * WebView.
 *
 * `require` rather than a top-level import so this module stays loadable from
 * Node — the package's own tests, and any tooling that reaches the barrel.
 */
function platformOwnsCookies(): boolean {
  try {
    const { Platform } = require("react-native") as { Platform?: { OS?: string } };
    return Platform?.OS === "ios" || Platform?.OS === "android";
  } catch {
    // Not React Native at all (Node, a bundler probe). Nothing persists
    // cookies for us here.
    return false;
  }
}

/**
 * One call that answers "how does this app carry its session?".
 *
 * ```ts
 * const session = createNativeSession();
 * export const client = createRenderJsonClient({ baseUrl, fetcher: session.fetcher });
 * export const { invoke } = createNativeInvoke({ baseUrl, jar: session.jar ?? false });
 * ```
 */
export function createNativeSession(options: NativeSessionOptions = {}): NativeSession {
  const { storage, fetcher = fetch, strategy } = options;
  const platformManaged = strategy ? strategy === "platform" : platformOwnsCookies();

  if (platformManaged) {
    // No wrapper at all. Anything that sets a `Cookie` header here would
    // override the OS store and start the growth described above.
    return { fetcher, platformManaged: true };
  }

  const jar = createCookieJar({ storage });
  return { fetcher: withCookieJar(jar, fetcher), jar, platformManaged: false };
}
