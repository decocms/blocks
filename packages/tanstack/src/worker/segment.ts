/**
 * What splits the edge cache: the device class, plus whatever the site's
 * `segment` option adds (a region, a sales channel, an A/B cohort). Every part
 * is in the cache key, and in the `__cseg` token the page hands to the browser,
 * so the CDN can cache client-side navigation data under the same split.
 */

export type Device = "mobile" | "tablet" | "desktop";

/** A cache split: part name to value. `device` is always present. */
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
