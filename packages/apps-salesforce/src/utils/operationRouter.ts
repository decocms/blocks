/**
 * URL-derived operation name router for Salesforce Commerce Cloud calls.
 *
 * Plugged into `@decocms/blocks/sdk/instrumentedFetch`'s `resolveOperation`.
 * SFCC's OCAPI/SCAPI surface is wide; naming by the first meaningful path
 * segment keeps the histogram label low-cardinality without hand-listing every
 * endpoint. Returns `undefined` when nothing meaningful is found, so the
 * framework falls back to `salesforce.fetch`.
 */

export function salesforceOperationRouter(url: string, _method: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    const qs = url.indexOf("?");
    pathname = qs >= 0 ? url.slice(0, qs) : url;
  }

  // SCAPI: /shopper/<api>/v1/... ; OCAPI: /s/<site>/dw/shop/<version>/<resource>/...
  const scapi = pathname.match(/\/shopper\/([^/]+)/);
  if (scapi) return `scapi.${scapi[1]}`;
  const ocapi = pathname.match(/\/dw\/(?:shop|data)\/[^/]+\/([^/?#]+)/);
  if (ocapi) return `ocapi.${ocapi[1]}`;

  // Fallback: first non-empty path segment.
  const seg = pathname.split("/").find(Boolean);
  return seg ? `path.${seg}` : undefined;
}
