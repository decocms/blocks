/**
 * v7's sticky A/B persistence: the `deco_segment` cookie
 * (`@decocms/blocks@7` sdk/flags.ts and sdk/experiments.ts' `stickyDecide`),
 * and the cookie its TanStack page route set after a page resolved
 * (`@decocms/tanstack@7` routes/cmsRoute.ts' `persistFlags`). Same bytes, so
 * a visitor keeps the group v7 put them in.
 *
 * The cookie is `btoa(encodeURIComponent(JSON.stringify({ active,
 * inactiveDrawn, pct, exp? })))`, written raw (analytics reads it with
 * `atob()`): `active` and `inactiveDrawn` list the cohorts the visitor was
 * drawn into and out of, `pct` holds each cohort's `round(traffic * 100)`, so
 * a new traffic share re-draws the visitor once, and `exp` holds N-way
 * experiment assignments, which this package only carries over.
 */
import { parseCookies } from "./context.ts";

/** The cookie holding a visitor's sticky decisions (classic deco segment). */
export const SEGMENT_COOKIE = "deco_segment";

/** One year: the group is sticky; the `pct` fingerprint handles re-draws. */
export const SEGMENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** A recorded decision: the cohort, the branch taken, and the fingerprint it was made under. */
export interface StoredFlag {
  /** The cohort: the random matcher's saved block name, or an experiment key. */
  name: string;
  /** `true`/`false` for a matcher; a variant id for an N-way experiment. */
  value: boolean | string;
  /** `round(traffic * 100)` for a matcher; `-1` when the cookie carried none. */
  pct: number;
}

interface DecoSegment {
  active?: string[];
  inactiveDrawn?: string[];
  pct?: Record<string, number>;
  exp?: Record<string, string>;
}

/** A 0–1 traffic share as the 0–100 integer fingerprint. */
export function trafficToPct(traffic: number): number {
  if (!Number.isFinite(traffic) || traffic <= 0) return 0;
  if (traffic >= 1) return 100;
  return Math.round(traffic * 100);
}

/**
 * The decisions in a `deco_segment` value. A cohort without a `pct` entry (a
 * cookie classic deco wrote) gets `pct: -1`, which always matches; a
 * malformed value gives `[]`.
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
    for (const [name, variantId] of Object.entries(seg.exp ?? {})) {
      out.push({ name, value: variantId, pct: pct[name] ?? -1 });
    }
    return out;
  } catch {
    return [];
  }
}

/** Decisions as a raw-base64 `deco_segment` value. */
export function serializeSegmentCookie(flags: StoredFlag[]): string {
  const active: string[] = [];
  const inactiveDrawn: string[] = [];
  const pct: Record<string, number> = {};
  const exp: Record<string, string> = {};
  for (const f of [...flags].sort((a, b) => a.name.localeCompare(b.name))) {
    if (typeof f.value === "string") {
      exp[f.name] = f.value;
    } else {
      (f.value ? active : inactiveDrawn).push(f.name);
    }
    pct[f.name] = f.pct;
  }
  const seg: DecoSegment = { active, inactiveDrawn, pct };
  if (Object.keys(exp).length) seg.exp = exp;
  return btoa(encodeURIComponent(JSON.stringify(seg)));
}

/**
 * A cache-key token for the decisions (v7's worker split its edge cache on
 * it): `name:1|0|variant:pct`, sorted, comma-joined; `""` when there are none.
 */
export function segmentCacheToken(flags: StoredFlag[]): string {
  if (!flags.length) return "";
  return [...flags]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}:${typeof f.value === "string" ? f.value : f.value ? "1" : "0"}:${f.pct}`)
    .join(",");
}

/**
 * v7's sticky assignment: a decision already recorded this request, else the
 * cookie's while its fingerprint matches (or it has none), else a fresh draw.
 * A new decision is pushed onto `recorded`.
 */
export function stickyDecide<V extends boolean | string>({
  name,
  fingerprint,
  recorded,
  stored,
  roll,
  accepts,
}: {
  name: string;
  fingerprint: number;
  recorded: StoredFlag[] | undefined;
  stored: StoredFlag[];
  roll: () => V;
  accepts?: (value: V) => boolean;
}): { value: V; isFresh: boolean } {
  const already = recorded?.find((f) => f.name === name && f.pct === fingerprint);
  if (already) return { value: already.value as V, isFresh: false };

  const prev = stored.find((f) => f.name === name);
  const usable =
    prev !== undefined &&
    (prev.pct === -1 || prev.pct === fingerprint) &&
    (!accepts || accepts(prev.value as V));

  const value = usable ? (prev.value as V) : roll();
  recorded?.push({ name, value, pct: fingerprint });
  return { value, isFresh: !usable };
}

/**
 * The `Set-Cookie` value that keeps this request's decisions, or `null` when
 * the visitor's cookie already says the same (v7 re-issued it only on a
 * change). The recorded decisions are merged over the cookie's, so a second
 * A/B page doesn't drop the first page's group:
 * `deco_segment=<value>; Max-Age=31536000; Path=/; SameSite=Lax`.
 *
 * A response that sets it must not be cached for other visitors (v7's worker
 * skipped the cache for it); the framework subpaths do that.
 */
export function segmentSetCookie(request: Request, flags: readonly StoredFlag[]): string | null {
  if (!flags.length) return null;
  const raw = parseCookies(request.headers.get("cookie") ?? "")[SEGMENT_COOKIE];
  const merged = new Map<string, StoredFlag>();
  for (const f of parseSegmentCookie(raw)) merged.set(f.name, f);
  for (const f of flags) merged.set(f.name, f);
  const serialized = serializeSegmentCookie([...merged.values()]);
  if (serialized === (raw ?? "")) return null;
  return `${SEGMENT_COOKIE}=${serialized}; Max-Age=${SEGMENT_COOKIE_MAX_AGE}; Path=/; SameSite=Lax`;
}
