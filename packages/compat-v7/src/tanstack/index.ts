/**
 * `@decocms/compat-v7/tanstack`: v7's device context for a TanStack Start
 * site on `@decocms/tanstack`. Safe in the browser bundle; the server half
 * (the request's device, the matchers' request context, the `deco_segment`
 * cookie) is `@decocms/compat-v7/tanstack/server`.
 *
 * Seed the provider with the device the server detected, returned from the
 * page's loader so the browser hydrates with the same value:
 *
 * ```tsx
 * // in the page loader (server): device: requestDevice()
 * <DeviceProvider value={page.device}>{sections}</DeviceProvider>
 * ```
 */

export type { Device } from "../device.ts";
export { DeviceContext, DeviceProvider, useDevice } from "../react/device.ts";
