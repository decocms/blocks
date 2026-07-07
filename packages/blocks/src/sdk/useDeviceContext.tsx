"use client";

/**
 * The hook/context half of device detection — split out of `useDevice.ts`
 * because it uses `createContext`/`useContext`, which Next.js's App Router
 * (unlike the Vite-based `@decocms/tanstack` binding, and unlike this
 * package's own Vitest/jsdom unit tests) statically rejects unless the
 * *file* that calls them carries a `"use client"` directive — Next's RSC
 * webpack loader errors ("This React Hook only works in a Client
 * Component") on ANY file reachable from a Server Component's module graph
 * that calls a client-only hook, even if the actual call site is never
 * invoked along that particular path.
 *
 * That's exactly what happened here: `packages/blocks/src/cms/sectionMixins.ts`
 * imports only the plain, hook-free `detectDevice()` from `useDevice.ts` for
 * its `withDevice()`/`withMobile()` section-loader mixins — a 100%
 * server-side call path (loaders receive a `Request`, never render). But
 * because `sectionMixins.ts` is pulled in by `cms/index.ts`, which
 * `createSiteSetup()` (runtime/setup.ts) imports, and a site's `setup.ts` is
 * typically imported for its side effects from `app/layout.tsx` (a Server
 * Component under `@decocms/next`), the *whole* `useDevice.ts` file used to
 * ride along into the server compilation graph — including the
 * `createContext`/`useContext` calls now isolated in this file, which had no
 * "use client" directive of their own. `@decocms/next`'s next-smoke fixture
 * (this plan's Task 9) is the first consumer to hit Next's real RSC
 * compiler, so this split was never needed before.
 *
 * `detectDevice`, `isMobileUA`, `checkMobile/Tablet/Desktop`, and the
 * `Device` type stay in `useDevice.ts` (no directive, safe to import from
 * server-only code); `useDevice.ts` re-exports `DeviceContext`/`useDevice`/
 * `DeviceProvider` from here so the public `@decocms/blocks/sdk/useDevice`
 * entry point (and every existing consumer, e.g.
 * `packages/tanstack/src/hooks/DecoPageRenderer.tsx`) is unchanged.
 */
import { createContext, createElement, type ReactNode, useContext } from "react";
import { type Device, resolveDeviceFromRuntime } from "./useDevice";

/**
 * React context for the resolved device. Populated by `<DeviceProvider>` at
 * the top of the framework tree (DecoPageRenderer mounts it for sites that
 * use the standard wiring). Once set, `useDevice()` reads from here in
 * preference to `AsyncLocalStorage`, which is known to be unreliable across
 * streaming SSR Suspense boundaries on Cloudflare Workers.
 */
export const DeviceContext = createContext<Device | null>(null);

/**
 * Get the current device type. Works everywhere:
 * - Server (loader, middleware, server function): reads User-Agent from RequestContext.
 * - Client (component, event handler): uses `window.innerWidth` breakpoints.
 *
 * @example
 * ```tsx
 * import { useDevice } from "@decocms/start/sdk/useDevice";
 *
 * // In a component:
 * const device = useDevice(); // "mobile" | "tablet" | "desktop"
 * ```
 */
export function useDevice(): Device {
  // Prefer the value resolved by <DeviceProvider> at the framework root —
  // safe across streaming-SSR Suspense boundaries where AsyncLocalStorage
  // can lose the request context. The try/catch keeps backward compat with
  // callers outside a React render (loaders, server functions, tests
  // without the framework root), where useContext throws "Invalid hook
  // call" — those callers fall through to the original runtime resolution.
  //
  // Rules-of-hooks note: `useContext` is called *unconditionally* inside the
  // try block — exactly once per `useDevice()` invocation. The catch only
  // fires when there is no React dispatcher at all (outside a render),
  // never *between* hooks in the same render. Hook order within a component
  // therefore remains consistent. Callers that conditionally call
  // `useDevice()` itself were already violating rules of hooks; this PR
  // doesn't change that.
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const fromContext = useContext(DeviceContext);
    if (fromContext) return fromContext;
  } catch {
    // Not in a React render — fall through.
  }
  return resolveDeviceFromRuntime();
}

/**
 * Wraps children in a `DeviceContext` populated by resolving the device once
 * here, at a point in the React tree where `AsyncLocalStorage` is reliable.
 * Any descendant calling `useDevice()` reads from this context instead of
 * re-resolving through ALS — preventing the "wrong device value cached at
 * the edge" failure mode that produces React #418 hydration mismatches.
 *
 * Mount this near the top of the React tree. `DecoPageRenderer` already
 * mounts it automatically; sites with custom roots can mount it explicitly:
 *
 * @example
 * ```tsx
 * <DeviceProvider>
 *   <App />
 * </DeviceProvider>
 * ```
 *
 * Pass an explicit `value` to override detection (useful for tests or
 * admin preview where the runtime UA isn't meaningful).
 */
export function DeviceProvider(props: { children: ReactNode; value?: Device }): ReactNode {
  const device = props.value ?? resolveDeviceFromRuntime();
  return createElement(DeviceContext.Provider, { value: device }, props.children);
}
