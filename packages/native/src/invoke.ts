/**
 * Calling the site's loaders and actions from a device.
 *
 * `createServerFn` — what the site itself uses for cart, user and wishlist — is
 * unreachable from off-device **by construction**: its transport is
 * `/_serverFn/<build-generated-id>` and its server half needs the TanStack
 * Start module graph. There is no RPC compiler in Metro.
 *
 * `/deco/invoke/<key>` is a plain HTTP POST, handled by `@decocms/blocks-admin`
 * and mounted by the site at `src/routes/deco/invoke.$.ts`. That is the door.
 *
 * Everything needed to walk through it already exists in `@decocms/blocks`:
 * `createAppInvokeWith({ basePath, fetcher })` gives the nested typed proxy and
 * the 404 → `<key>.ts` retry. This module only supplies the two things a phone
 * needs and a browser gets for free — an absolute origin, and a cookie jar.
 *
 * ## The session is the hard part
 *
 * Nothing is mirrored into a response body: the site keeps session state
 * entirely in cookies (`checkout.vtex.com__orderFormId`, `vtex_session`, …).
 * React Native has no cookie jar and its `Headers` collapses repeated
 * `Set-Cookie` values, so without `./cookies` a cart round-trip silently loses
 * its orderFormId and the user reaches checkout with an empty cart.
 *
 * ## What this does not solve
 *
 * `/deco/invoke` has **no authentication** — no token, no origin check. Every
 * registered loader and action is a public endpoint, which is why
 * `generate-invoke.ts` ships a `PRIVILEGED_ACTIONS` deny-list. Shipping an app
 * makes that more urgent, not less, but auth is a server-side design decision
 * and does not belong here. `headers` is the seam for it once it exists.
 */

import { createAppInvokeWith, type InvokeFetcher } from "@decocms/blocks/sdk/invoke";
import { type CookieJar, type CookieStorage, createCookieJar, withCookieJar } from "./cookies";

export interface NativeInvokeOptions {
  /** Origin of the deployed worker, e.g. `https://loja.example.com`. */
  baseUrl: string;
  /**
   * Cookie jar carrying the session. Omit and one is created; pass a shared
   * instance to use the same session for `?renderJson` page loads.
   */
  jar?: CookieJar;
  /** Persists the jar across launches. Ignored when `jar` is supplied. */
  storage?: CookieStorage;
  /** Extra headers on every call — the seam for auth, once the server has any. */
  headers?: Record<string, string>;
  /** Underlying transport. Wrapped with the jar. */
  fetcher?: typeof fetch;
}

/**
 * A typed invoke proxy for a device.
 *
 * The type parameter is the flat handler map — `@decocms/blocks`'s
 * `NestedFromFlat` explodes it into the nested object:
 *
 * ```ts
 * const invoke = createNativeInvoke<{
 *   "vtex/actions/checkout/addItemsToCart": (p: AddItems) => Promise<OrderForm>;
 * }>({ baseUrl });
 *
 * await invoke.vtex.actions.checkout.addItemsToCart({ orderItems });
 * ```
 *
 * Generating that map from the site is the next step (`--platform native`);
 * until then it can be hand-written, and untyped calls still work.
 */
export function createNativeInvoke<T extends Record<string, any> = Record<string, any>>(
  options: NativeInvokeOptions,
) {
  const { baseUrl, headers, fetcher = fetch } = options;
  const jar = options.jar ?? createCookieJar({ storage: options.storage });

  const withHeaders: typeof fetch = headers
    ? (input, init) =>
        fetcher(input, { ...init, headers: { ...headers, ...(init?.headers as object) } })
    : fetcher;

  const invoke = createAppInvokeWith<T>({
    // Absolute: there is no page origin to be relative to.
    basePath: `${baseUrl.replace(/\/$/, "")}/deco/invoke`,
    fetcher: withCookieJar(jar, withHeaders) as InvokeFetcher,
  });

  return { invoke, jar };
}
