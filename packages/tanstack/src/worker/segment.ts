/**
 * What a site's own cache splits on: the device class of a request, and a
 * segment (the device plus the site's own parts: a region, a sales channel) as
 * one stable string, for a cache key and for the `__cseg` token the page hands
 * to the browser, so a CDN can keep client-side navigation data under the
 * same split. The worker caches nothing itself (the README's worker-entry
 * recipe does).
 */

export type Device = "mobile" | "tablet" | "desktop";

/** A cache split: part name to value (the device, and the site's own parts). */
export type Segment = Readonly<Record<string, string>>;

// v7's expressions (@decocms/blocks/sdk/detectDevice): tablets first, so
// `android(?!.*mobile)` takes Android tablets before the phone rule.
const MOBILE_RE = /mobile|android.*mobile|iphone|ipod|webos|blackberry|opera mini|iemobile/i;
const TABLET_RE = /ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i;

export function detectDevice(userAgent: string): Device {
  if (TABLET_RE.test(userAgent)) return "tablet";
  if (MOBILE_RE.test(userAgent)) return "mobile";
  return "desktop";
}

/** A segment as one stable string: parts sorted by name, values URL-encoded. */
export function segmentKey(segment: Segment): string {
  return Object.keys(segment)
    .filter((name) => segment[name] !== undefined && segment[name] !== "")
    .sort()
    .map((name) => `${name}=${encodeURIComponent(segment[name] as string)}`)
    .join("|");
}

/** DJB2 over UTF-16 code units, as 8 hex digits. */
export function djb2Hex(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The `__cseg` token for a segment and cache version, or `null` when there is
 * no version to bind it to (a dev build), so stale URLs can never match.
 */
export function segmentToken(segment: Segment, version: string): string | null {
  if (!version || version === "dev") return null;
  return djb2Hex(`${segmentKey(segment)}|${version}`);
}
