/**
 * Sticky A/B flag persistence via the `deco_segment` cookie — shared by the
 * resolver (SSR variant selection), the worker entry (cache-key cohort
 * splitting), and consumed by analytics (@decocms/apps OneDollarStats reads
 * the same cookie to enrich pageviews/events).
 *
 * ## Why
 *
 * `website/matchers/random.ts` is a stateless `Math.random() < traffic`, so a
 * visitor's variant used to be re-rolled on every request AND frozen per
 * edge-cache entry (the HTML is cached and the cache key never carried the
 * variant). The variant a first visitor happened to roll then got served to
 * everyone in that device/geo bucket, and analytics never saw the flag.
 *
 * ## Cookie format
 *
 * `deco_segment` is the classic deco segment cookie:
 * `btoa(encodeURIComponent(JSON.stringify({ active, inactiveDrawn, pct })))`.
 * - `active` — flag names the visitor was assigned to (`true` branch).
 * - `inactiveDrawn` — flag names drawn but not matched (`false` branch).
 * - `pct` — `{ name: round(traffic*100) }`, a deco-start extension (analytics
 *   ignores unknown fields) used as the re-roll fingerprint: when the operator
 *   changes `traffic` and redeploys, the fingerprint no longer matches and the
 *   visitor is re-rolled once, then re-sticks — same self-healing scheme as
 *   {@link ./abTesting.ts}.
 *
 * The cookie MUST be written un-encoded (raw base64) — OneDollarStats reads it
 * with `atob()` directly. Base64's `+ / =` are all valid cookie-value octets
 * (RFC 6265), so pass `encode: (v) => v` to the cookie setter.
 */

/** Cookie carrying the visitor's sticky flag decisions (classic deco segment). */
export const SEGMENT_COOKIE = "deco_segment";

/** A recorded flag decision: which named flag, the branch taken, and the
 *  `traffic` fingerprint (0–100) it was decided under. */
export interface StoredFlag {
  /** Matcher block name, e.g. "TestHero". Stable identity for the cohort. */
  name: string;
  /** The branch the visitor was assigned to. */
  value: boolean;
  /** `round(traffic * 100)` at assignment time — the re-roll fingerprint. */
  pct: number;
}

/** Wire shape of the `deco_segment` cookie payload. */
interface DecoSegment {
  active?: string[];
  inactiveDrawn?: string[];
  /** deco-start extension: per-flag traffic fingerprint. Ignored by analytics. */
  pct?: Record<string, number>;
}

/** Convert a 0–1 traffic ratio to the 0–100 integer fingerprint. */
export function trafficToPct(traffic: number): number {
  if (!Number.isFinite(traffic) || traffic <= 0) return 0;
  if (traffic >= 1) return 100;
  return Math.round(traffic * 100);
}

/**
 * Parse the `deco_segment` cookie value into decisions. The value is raw
 * base64 (no URL-decoding needed). Foreign cookies without the `pct` extension
 * parse with `pct: -1`, which the resolver treats as "always matches" so a
 * classic-deco segment stays sticky instead of re-rolling. Malformed cookies
 * yield `[]`.
 */
export function parseSegmentCookie(raw: string | undefined | null): StoredFlag[] {
  if (!raw) return [];
  try {
    const seg = JSON.parse(decodeURIComponent(atob(raw))) as DecoSegment;
    const pct = seg.pct ?? {};
    const out: StoredFlag[] = [];
    for (const name of seg.active ?? []) out.push({ name, value: true, pct: pct[name] ?? -1 });
    for (const name of seg.inactiveDrawn ?? []) {
      out.push({ name, value: false, pct: pct[name] ?? -1 });
    }
    return out;
  } catch {
    return [];
  }
}

/** Serialize decisions into a raw-base64 `deco_segment` cookie value. */
export function serializeSegmentCookie(flags: StoredFlag[]): string {
  const active: string[] = [];
  const inactiveDrawn: string[] = [];
  const pct: Record<string, number> = {};
  for (const f of [...flags].sort((a, b) => a.name.localeCompare(b.name))) {
    (f.value ? active : inactiveDrawn).push(f.name);
    pct[f.name] = f.pct;
  }
  const seg: DecoSegment = { active, inactiveDrawn, pct };
  return btoa(encodeURIComponent(JSON.stringify(seg)));
}

/**
 * Stable token for the cache key — includes the `pct` fingerprint so a
 * `traffic` change lands cohorts in fresh buckets. Empty string when there are
 * no flags, so non-A/B pages keep sharing one entry.
 */
export function segmentCacheToken(flags: StoredFlag[]): string {
  if (!flags.length) return "";
  return [...flags]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}:${f.value ? "1" : "0"}:${f.pct}`)
    .join(",");
}
