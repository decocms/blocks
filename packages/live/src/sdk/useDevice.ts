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

import { RequestContext } from "./requestContext";

export type Device = "mobile" | "tablet" | "desktop";

// `DeviceContext`, the `useDevice()` hook, and `DeviceProvider` live in
// `./useDeviceContext` (a `"use client"` file) and are re-exported below for
// full backward compatibility with this module's public API — see that
// file's doc comment for why the split exists. Everything that stays in
// *this* file is a plain, hook-free function, safe to import from
// server-only code (e.g. `cms/sectionMixins.ts`'s `withDevice()`/
// `withMobile()` loader mixins) without dragging a client-only hook/context
// boundary into a Server Component's module graph.
export { DeviceContext, useDevice, DeviceProvider } from "./useDeviceContext";

// Android phones include "Mobile" in their UA; Android tablets do not.
// Check TABLET_RE first so `android(?!.*mobile)` captures tablets before
// the MOBILE_RE `android.*mobile` branch matches phones.
export const MOBILE_RE = /mobile|android.*mobile|iphone|ipod|webos|blackberry|opera mini|iemobile/i;
export const TABLET_RE = /ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i;

/**
 * Simple mobile-or-not check (mobile + tablet = true).
 * Use this for cache key splitting or any context where you
 * only need a mobile/desktop binary decision.
 */
export function isMobileUA(userAgent: string): boolean {
  return MOBILE_RE.test(userAgent) || TABLET_RE.test(userAgent);
}

/**
 * Detect device type from a User-Agent string.
 * Pure function — no side effects, works anywhere.
 */
export function detectDevice(userAgent: string): Device {
  if (TABLET_RE.test(userAgent)) return "tablet";
  if (MOBILE_RE.test(userAgent)) return "mobile";
  return "desktop";
}

/**
 * Resolve the current device from the ambient runtime (RequestContext on the
 * server, `navigator.userAgent` on the client) — no React hooks involved.
 * Used both by the plain `check*()` helpers below and by `useDevice()`/
 * `DeviceProvider` in `./useDeviceContext`.
 */
export function resolveDeviceFromRuntime(): Device {
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
