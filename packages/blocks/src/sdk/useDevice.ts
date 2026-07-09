/**
 * Server-side device detection via RequestContext.
 *
 * @example
 * ```tsx
 * // In a section loader or server function:
 * import { detectDevice } from "@decocms/start/sdk/useDevice";
 *
 * export function loader(props: Props, req: Request) {
 *   const device = detectDevice(req.headers.get("user-agent") ?? "");
 *   return { ...props, device };
 * }
 *
 * // Or via RequestContext (no request argument needed):
 * import { useDevice } from "@decocms/start/sdk/useDevice";
 *
 * export function loader(props: Props) {
 *   const device = useDevice();
 *   return { ...props, isMobile: device === "mobile" };
 * }
 * ```
 */

import { detectDevice } from "./detectDevice";
import { RequestContext } from "./requestContext";

// The pure UA-parsing half (`Device`, `MOBILE_RE`, `TABLET_RE`,
// `isMobileUA`, `detectDevice`) lives in `./detectDevice` — a leaf with no
// React and no RequestContext — and is re-exported below for backward
// compatibility. Modules that can land in a Next.js route-handler graph
// (`cms/sectionMixins.ts`, `sdk/requestContext.ts`) MUST import that leaf
// directly, not this file: this file also re-exports the `"use client"`
// context half, which crashes route handlers (see ./detectDevice's doc
// comment for the vendored-RSC-React mechanics).
export { type Device, detectDevice, isMobileUA, MOBILE_RE, TABLET_RE } from "./detectDevice";

// `DeviceContext`, the `useDevice()` hook, and `DeviceProvider` live in
// `./useDeviceContext` (a `"use client"` file) and are re-exported below for
// full backward compatibility with this module's public API — see that
// file's doc comment for why the split exists.
export { DeviceContext, useDevice, DeviceProvider } from "./useDeviceContext";

/**
 * Resolve the current device from the ambient runtime (RequestContext on the
 * server, `navigator.userAgent` on the client) — no React hooks involved.
 * Used both by the plain `check*()` helpers below and by `useDevice()`/
 * `DeviceProvider` in `./useDeviceContext`.
 */
export function resolveDeviceFromRuntime(): ReturnType<typeof detectDevice> {
  // Server: use RequestContext UA header
  if (typeof document === "undefined") {
    const ctx = RequestContext.current;
    if (!ctx) return "desktop";
    const ua = ctx.request.headers.get("user-agent") ?? "";
    return detectDevice(ua);
  }
  // Client: use navigator.userAgent for consistency with server-side UA detection.
  // Using viewport width would produce different results between SSR and
  // hydration (server sees UA, client sees pixels), causing hydration mismatch.
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return detectDevice(ua);
}

/**
 * Check if the current request is from a mobile device.
 */
export function checkMobile(): boolean {
  const ctx = RequestContext.current;
  if (!ctx) return false;
  return detectDevice(ctx.request.headers.get("user-agent") ?? "") === "mobile";
}

/**
 * Check if the current request is from a tablet device.
 */
export function checkTablet(): boolean {
  const ctx = RequestContext.current;
  if (!ctx) return false;
  return detectDevice(ctx.request.headers.get("user-agent") ?? "") === "tablet";
}

/**
 * Check if the current request is from a desktop device.
 */
export function checkDesktop(): boolean {
  const ctx = RequestContext.current;
  if (!ctx) return true;
  return detectDevice(ctx.request.headers.get("user-agent") ?? "") === "desktop";
}
