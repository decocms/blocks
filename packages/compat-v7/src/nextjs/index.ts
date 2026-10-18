/**
 * `@decocms/compat-v7/nextjs`: v7's device context for a Next.js App Router
 * site on `@decocms/nextjs`. The provider is a client component (its module
 * says `"use client"`), so a server component renders it; the server half
 * (the request's device, the matchers' request context, the `deco_segment`
 * cookie) is `@decocms/compat-v7/nextjs/server`, and the page URL the
 * matchers read comes from the site's proxy (`@decocms/compat-v7/nextjs/proxy`).
 *
 * ```tsx
 * // app/layout.tsx (a server component)
 * <DeviceProvider value={await requestDevice()}>{children}</DeviceProvider>
 * ```
 */

export type { Device } from "../device.ts";
export { DeviceContext, DeviceProvider, useDevice } from "../react/device.ts";
