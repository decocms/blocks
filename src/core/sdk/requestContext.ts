/**
 * Per-request context backed by an injectable RequestStore.
 *
 * Binds request-scoped state (request, abort signal, device info, flags) that
 * any code in the call stack can access without prop drilling.
 *
 * **Framework-agnostic.** This file lives in `core/` and never imports
 * `node:async_hooks` directly. Hosts that want AsyncLocalStorage semantics
 * must call `setRequestContextStore()` with an ALS-backed RequestStore
 * (see `tanstack/runtime/alsRequestStore.ts`). When no store is installed,
 * `RequestContext` operates in a noop mode and getters return safe defaults
 * (or `undefined` for the optional `current` accessor).
 *
 * **Design decisions:**
 * - We do NOT monkey-patch global `fetch`. Instead, `RequestContext.fetch`
 *   provides a fetch that auto-injects the request's AbortSignal.
 * - The context is optional -- code that doesn't need it just doesn't call it.
 *   Commerce loaders receive it explicitly via the updated `CommerceLoader` sig.
 *
 * @example
 * ```ts
 * // In a host bootstrap (e.g. installTanStackRuntime):
 * import { setRequestContextStore } from "@decocms/start/sdk/requestContext";
 * import { createAlsRequestStore } from "@decocms/start/tanstack";
 * setRequestContextStore(createAlsRequestStore());
 *
 * // In TanStack Start middleware:
 * import { RequestContext } from "@decocms/start/sdk/requestContext";
 *
 * const middleware = createMiddleware().server(async ({ next, request }) => {
 *   return RequestContext.run(request, () => next());
 * });
 *
 * // Anywhere in the call stack:
 * const req = RequestContext.request;       // the current request
 * const signal = RequestContext.signal;     // AbortSignal
 * const resp = await RequestContext.fetch(url); // auto-aborts on disconnect
 * ```
 */

import { isMobileUA } from "./useDevice";
import { noopRequestStore, type RequestStore } from "../runtime/requestStore";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface RequestContextData {
  request: Request;
  signal: AbortSignal;
  startedAt: number;
  /** Lazily computed device type. */
  _device?: "mobile" | "desktop";
  /** Lazily computed bot detection result. */
  _isBot?: boolean;
  /** Arbitrary bag for middleware to attach custom data. */
  bag: Map<string, unknown>;
  /**
   * Outgoing response headers that handlers can write to.
   * Invoke handlers (actions/loaders) use this to forward Set-Cookie
   * and other headers from upstream APIs (e.g., VTEX checkout).
   * The invoke HTTP handler copies these into the final Response.
   *
   * This mirrors deco-cx/deco's `ctx.response.headers` pattern where
   * `proxySetCookie(apiResponse.headers, ctx.response.headers)` forwards
   * cookies transparently.
   */
  responseHeaders: Headers;
}

// -------------------------------------------------------------------------
// Storage (injectable)
// -------------------------------------------------------------------------

let store: RequestStore<RequestContextData> =
  noopRequestStore as RequestStore<RequestContextData>;

/**
 * Install the runtime-specific RequestStore implementation.
 *
 * Hosts call this once at startup. The default is a noop store, which means
 * `RequestContext.run` invokes the callback directly but `RequestContext.current`
 * always returns `null` and getters that throw outside a scope continue to throw.
 *
 * Pass `undefined` to reset to the noop store (useful in tests).
 */
export function setRequestContextStore(
  s: RequestStore<RequestContextData> | undefined,
): void {
  store = s ?? (noopRequestStore as RequestStore<RequestContextData>);
}

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|googlebot|yandex|baidu|duckduck/i;

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

export const RequestContext = {
  /**
   * Run a function within a request context.
   *
   * Call this at the outermost middleware level. Everything inside
   * the callback (loaders, resolvers, utilities) can access the
   * context via the static getters.
   */
  run<T>(request: Request, fn: () => T): T {
    const controller = new AbortController();

    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort(request.signal.reason);
      } else {
        request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), {
          once: true,
        });
      }
    }

    const ctx: RequestContextData = {
      request,
      signal: controller.signal,
      startedAt: Date.now(),
      bag: new Map(),
      responseHeaders: new Headers(),
    };

    return store.run(ctx, fn);
  },

  /**
   * Get the current request context, or null if not in a request scope.
   */
  get current(): RequestContextData | null {
    return store.get() ?? null;
  },

  /**
   * Get the current Request object.
   * @throws if called outside a request context
   */
  get request(): Request {
    const ctx = store.get();
    if (!ctx) throw new Error("RequestContext.request accessed outside a request scope");
    return ctx.request;
  },

  /**
   * Get the current AbortSignal.
   * Use this to cancel in-flight operations when the client disconnects.
   */
  get signal(): AbortSignal {
    const ctx = store.get();
    if (!ctx) throw new Error("RequestContext.signal accessed outside a request scope");
    return ctx.signal;
  },

  /**
   * Detected device type based on User-Agent.
   */
  get device(): "mobile" | "desktop" {
    const ctx = store.get();
    if (!ctx) return "desktop";
    if (ctx._device) return ctx._device;
    const ua = ctx.request.headers.get("user-agent") ?? "";
    ctx._device = isMobileUA(ua) ? "mobile" : "desktop";
    return ctx._device;
  },

  /**
   * Whether the request appears to be from a bot/crawler.
   */
  get isBot(): boolean {
    const ctx = store.get();
    if (!ctx) return false;
    if (ctx._isBot !== undefined) return ctx._isBot;
    const ua = ctx.request.headers.get("user-agent") ?? "";
    ctx._isBot = BOT_RE.test(ua);
    return ctx._isBot;
  },

  /**
   * Elapsed time since the request started (in milliseconds).
   */
  get elapsed(): number {
    const ctx = store.get();
    if (!ctx) return 0;
    return Date.now() - ctx.startedAt;
  },

  /**
   * Fetch with automatic AbortSignal injection.
   *
   * When the client disconnects, this fetch aborts automatically.
   * This is NOT a global monkey-patch -- only code that explicitly
   * calls `RequestContext.fetch()` gets this behavior.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const ctx = store.get();
    if (!ctx) return globalThis.fetch(input, init);

    return globalThis.fetch(input, {
      ...init,
      signal: init?.signal ?? ctx.signal,
    });
  },

  /**
   * Outgoing response headers. Handlers write here; the invoke endpoint
   * copies them into the HTTP Response (mirroring ctx.response.headers
   * from deco-cx/deco).
   */
  get responseHeaders(): Headers {
    const ctx = store.get();
    if (!ctx) throw new Error("RequestContext.responseHeaders accessed outside a request scope");
    return ctx.responseHeaders;
  },

  /**
   * Get/set arbitrary values in the request bag.
   * Useful for middleware to pass data to loaders.
   */
  getBag<T>(key: string): T | undefined {
    const ctx = store.get();
    return ctx?.bag.get(key) as T | undefined;
  },

  setBag(key: string, value: unknown): void {
    const ctx = store.get();
    ctx?.bag.set(key, value);
  },

  /**
   * Get an app's state from the request bag.
   * Apps register their state via `setupApps()` which injects it
   * into the bag as `app:{name}:state` before each request.
   *
   * @example
   * ```ts
   * import { RequestContext } from "@decocms/start/sdk/requestContext";
   * import type { VtexState } from "@decocms/apps/vtex/mod";
   *
   * const vtex = RequestContext.getAppState<VtexState>("vtex");
   * if (vtex) console.log(vtex.config.account);
   * ```
   */
  getAppState<T>(appName: string): T | undefined {
    const ctx = store.get();
    return ctx?.bag.get(`app:${appName}:state`) as T | undefined;
  },
};
