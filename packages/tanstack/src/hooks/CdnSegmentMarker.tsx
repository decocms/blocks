/**
 * Publishes the CDN segment token this server computed, so `decoServerFnFetch`
 * can echo it back on `/_serverFn` URLs.
 *
 * Only the server can produce this value: the segment includes dimensions the
 * browser cannot observe — region is resolved from `request.cf.regionCode`.
 * A client that derives its own token therefore never matches on a
 * regionalized store, which is exactly why this component exists.
 *
 *  - **Server:** read the token from the RequestContext bag (filled by
 *    `createDecoWorkerEntry`) and emit a tiny inline `<script>`.
 *  - **Client:** the bag is a no-op stub, so the read yields undefined and this
 *    renders nothing — the global set during SSR is already on `window`.
 *
 * Safe in a cached response: the Worker's edge cache keys on the segment, so a
 * stored entry carries the token of its own segment. And a stale token is
 * harmless by construction — the Worker verifies by recomputing and falls back
 * to `no-store` when it doesn't match.
 */
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { CSEG_BAG_KEY, CSEG_GLOBAL } from "../sdk/cdnSegment";

export function CdnSegmentMarker() {
  const token = RequestContext.getBag<string>(CSEG_BAG_KEY);
  if (!token) return null;
  return (
    <script
      // A hash this server computed, not user input. JSON.stringify keeps it
      // inert regardless.
      dangerouslySetInnerHTML={{
        __html: `window.${CSEG_GLOBAL}=${JSON.stringify(token)}`,
      }}
    />
  );
}
