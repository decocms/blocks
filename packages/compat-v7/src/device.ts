/**
 * v7's user-agent device detection (`@decocms/blocks/sdk/detectDevice` on
 * 7.x): the same patterns and the same order, so a site keeps v7's
 * mobile/tablet/desktop split. Pure: the caller passes the User-Agent
 * (`request.headers.get("user-agent") ?? ""`). `device.test.ts` pins it
 * against v7's own code.
 */

export type Device = "mobile" | "tablet" | "desktop";

// Android phones include "Mobile" in their UA; Android tablets do not.
// Check TABLET_RE first so `android(?!.*mobile)` captures tablets before
// the MOBILE_RE `android.*mobile` branch matches phones.
export const MOBILE_RE = /mobile|android.*mobile|iphone|ipod|webos|blackberry|opera mini|iemobile/i;
export const TABLET_RE = /ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i;

/** Mobile or tablet: the binary split a cache key or a layout switch needs. */
export function isMobileUA(userAgent: string): boolean {
  return MOBILE_RE.test(userAgent) || TABLET_RE.test(userAgent);
}

/** The device a User-Agent string names; anything unrecognized is "desktop". */
export function detectDevice(userAgent: string): Device {
  if (TABLET_RE.test(userAgent)) return "tablet";
  if (MOBILE_RE.test(userAgent)) return "mobile";
  return "desktop";
}
