/**
 * Segment marker on `/_serverFn` URLs, so a cache in front of the Worker can
 * serve the response without invoking it.
 *
 * The problem: whatever sits in front (Workers Cache, a CDN rule) keys on the
 * raw URL. The Worker keys on a SYNTHETIC Request carrying
 * `__seg`/`__cf_device`/`__bot`/`__fetch`/`__abf` (`buildCacheKey` in
 * `./workerEntry`) — params the URL never shows. That mismatch is why the
 * framework stamps `CDN-Cache-Control: no-store` on public responses.
 *
 * The fix: put the segment in the URL itself, so the two keys become
 * equivalent.
 *
 * ## Why the SERVER issues the token
 *
 * The first version had the client derive the token from what it could see
 * (`navigator.userAgent`). That only ever worked on sites whose segment
 * reduces to device alone. A regionalized VTEX store — most of them — segments
 * on region too, and region is resolved from `request.cf.regionCode`, which
 * exists **only** on the server. The client cannot see it, so its token never
 * matched and the feature stayed permanently inert.
 *
 * So the server computes the token from the segment it already built, publishes
 * it to the page, and the client only echoes it back. The Worker still verifies
 * by recomputing — the marker is never trusted, so a stale or forged one just
 * keeps the `no-store`.
 *
 * The token is a hash rather than readable fields: `regionId` can contain the
 * separator (`v2.XXXX`), values would need escaping, and there is no reason to
 * publish a visitor's region in a URL that ends up in logs.
 */

import { djb2Hex } from "@decocms/blocks/sdk/djb2";

/** `__d` is reserved: `workerEntry` uses `?__d=` as an OTel debug flag. */
export const CSEG_PARAM = "__cseg";

/** Global the SSR publishes the token on, read back by `decoServerFnFetch`. */
export const CSEG_GLOBAL = "__DECO_CSEG";

/** RequestContext bag key the worker entry fills before rendering. */
export const CSEG_BAG_KEY = "deco.cdn.segmentToken";

/**
 * Build the token for a segment, or `null` when this request must not be
 * cached in front of the Worker.
 *
 * `null` — i.e. keep `no-store` — when:
 *
 * - the visitor is logged in. Personalized responses never belong in a shared
 *   entry, no matter how precise the key is.
 * - there is no build hash, or it is `"dev"`. The build is part of the token
 *   because deploying does not purge the cache in front, so the URL has to
 *   change on its own when the bundle does.
 *
 * Everything else in the segment — device, sales channel, region, a site's own
 * custom dimensions — is folded INTO the token rather than rejected. That is
 * the difference from the first version: those are what the key needs to
 * distinguish, not reasons to give up on caching.
 */
export function segmentToken(
  segmentDescriptor: string,
  loggedIn: boolean,
  buildHash: string | undefined,
): string | null {
  if (loggedIn) return null;
  if (!buildHash || buildHash === "dev") return null;
  if (!segmentDescriptor) return null;

  return djb2Hex(`${segmentDescriptor}|${buildHash}`);
}
