/**
 * Segment marker on `/_serverFn` URLs, so Cloudflare's CDN can serve the
 * response without invoking the Worker.
 *
 * The problem: the CDN keys on the raw URL. The Worker keys on a SYNTHETIC
 * Request carrying `__seg`/`__v`/`__bot`/`__fetch`/`__abf` (`buildCacheKey` in
 * `./workerEntry`) — params the CDN never sees. That mismatch is why the
 * framework stamps `CDN-Cache-Control: no-store` on every public response, and
 * why 100% of traffic comes back `cf-cache-status: BYPASS`.
 *
 * The fix: put the segment in the URL itself. The CDN's key then becomes
 * equivalent to the Worker's, and relaxing the `no-store` is safe.
 *
 * This is the ONLY definition of the token format. The client uses it to build
 * the marker, the worker uses it to recompute and compare — same function on
 * both sides, so they cannot drift.
 *
 * Note the split of responsibilities: this module covers what is observable on
 * BOTH sides (device + build). Request-only dimensions — bot UA, the A/B
 * cookie — are checked by the worker alone, in `cdnServerFnToken`. A client
 * that can't see them just emits a marker that fails verification, which keeps
 * the existing `no-store`.
 */

import type { Device } from "@decocms/blocks/sdk/detectDevice";

/** `__d` is reserved: `workerEntry` uses `?__d=` as an OTel debug flag. */
export const CSEG_PARAM = "__cseg";

/**
 * The subset of `SegmentKey` this token can express.
 *
 * Deliberately structural rather than importing `SegmentKey` from
 * `./workerEntry`: this module is bundled into the CLIENT, and workerEntry
 * pulls in the whole server graph.
 */
export interface CdnSegment {
  device: Device;
  loggedIn?: boolean;
  salesChannel?: string;
  regionId?: string;
  [key: string]: unknown;
}

/**
 * The segment token, or `null` when this request must not be CDN-cached.
 *
 * Returns `null` — keeping today's `no-store` — when:
 *
 * - there is any personalization beyond device (`loggedIn`, `salesChannel`,
 *   `regionId`, or any custom `SegmentKey` field a site added). Only device is
 *   safe to expose in a URL; everything else has to keep resolving in the
 *   Worker. Unknown fields fail closed precisely because we can't know whether
 *   a site's custom dimension is personal.
 * - there is no build hash, or it is `"dev"`. The build is part of the token
 *   because deploying does NOT purge the CDN (the framework's purge clears
 *   `caches.default`), so the URL has to change on its own when the bundle does.
 */
export function segmentToken(seg: CdnSegment, buildHash: string | undefined): string | null {
  if (!buildHash || buildHash === "dev") return null;
  if (!seg.device) return null;
  if (seg.loggedIn || seg.salesChannel || seg.regionId) return null;

  // Any dimension we don't recognize is assumed personal.
  for (const [key, value] of Object.entries(seg)) {
    if (key === "device") continue;
    if (value === undefined || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === "") continue;
    return null;
  }

  return `${seg.device}.${buildHash}`;
}
