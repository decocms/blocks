/**
 * Read the current visitor's `orderFormId` from the request cookie.
 *
 * Shared by every Cart v2 loader. Returns `undefined` for first-time visitors
 * (no cart yet) — loaders MUST treat that as "empty, do not create" so a page
 * view never provisions a zero-item OrderForm on VTEX.
 */

import { RequestContext } from "@decocms/blocks/sdk/requestContext";

export const ORDER_FORM_COOKIE = "checkout.vtex.com__orderFormId";

/** Extract `orderFormId` from the inbound request cookie header, if present. */
export function readOrderFormIdFromRequest(cookieName = ORDER_FORM_COOKIE): string | undefined {
  const ctx = RequestContext.current;
  const cookieHeader = ctx?.request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Resolve the orderFormId a loader should use: an explicit prop wins, else the
 * cookie. `undefined` means "no cart exists yet".
 */
export function resolveOrderFormId(
  explicit?: string,
  cookieName = ORDER_FORM_COOKIE,
): string | undefined {
  return explicit ?? readOrderFormIdFromRequest(cookieName);
}
