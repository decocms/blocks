/**
 * Pure User-Agent device detection — no React, no RequestContext, no
 * side effects. Import from HERE (not `./useDevice`) in any module that can
 * end up in a Next.js App Router **route handler** graph.
 *
 * Why this file exists: `useDevice.ts` re-exports the `"use client"`
 * context half (`./useDeviceContext`, which calls `createContext` at module
 * scope) for backward compatibility. That re-export is harmless in Server
 * Components — Next honors the `"use client"` boundary there — but route
 * handlers (App Router route.ts files) have NO client graph: the directive
 * is ignored, the module executes against Next's vendored **RSC** React
 * (`vendored/rsc/react.js`), and that build has no `createContext`, so the
 * whole route module crashes at evaluation time
 * ("...createContext is not a function"). `@decocms/nextjs`'s admin route
 * handlers reach device detection via `cms/sectionMixins.ts`
 * (`detectDevice`) and `sdk/requestContext.ts` (`isMobileUA`) — both now
 * import this leaf so their graphs never touch the client context file.
 */

export type Device = "mobile" | "tablet" | "desktop";

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
