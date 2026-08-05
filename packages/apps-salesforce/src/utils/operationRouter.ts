/**
 * URL-derived operation name router for Salesforce Commerce Cloud calls.
 *
 * Plugged into `@decocms/blocks/sdk/instrumentedFetch`'s `resolveOperation`.
 * SFCC's OCAPI/SCAPI surface is wide; naming by the first meaningful path
 * segment keeps the histogram label low-cardinality without hand-listing every
 * endpoint. Returns `undefined` when nothing meaningful is found, so the
 * framework falls back to `salesforce.fetch`.
 */

import { extractPathname } from "@decocms/blocks/sdk/urlUtils";

export function salesforceOperationRouter(url: string, _method: string): string | undefined {
  const pathname = extractPathname(url);

  // SCAPI: /shopper/<api>/v1/... ; OCAPI: /s/<site>/dw/shop/<version>/<resource>/...
  const scapi = pathname.match(/\/shopper\/([^/]+)/);
  if (scapi) return `scapi.${scapi[1]}`;
  const ocapi = pathname.match(/\/dw\/(?:shop|data)\/[^/]+\/([^/?#]+)/);
  if (ocapi) return `ocapi.${ocapi[1]}`;

  // Fallback: first non-empty path segment.
  const seg = pathname.split("/").find(Boolean);
  return seg ? `path.${seg}` : undefined;
}
