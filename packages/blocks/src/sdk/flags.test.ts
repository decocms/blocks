import { describe, expect, it } from "vitest";
import {
  parseSegmentCookie,
  type StoredFlag,
  segmentCacheToken,
  serializeSegmentCookie,
  trafficToPct,
} from "./flags";

describe("trafficToPct", () => {
  it("maps a ratio to a 0-100 integer", () => {
    expect(trafficToPct(0.5)).toBe(50);
    expect(trafficToPct(0.234)).toBe(23);
  });

  it("clamps out-of-range and non-finite values", () => {
    expect(trafficToPct(0)).toBe(0);
    expect(trafficToPct(-1)).toBe(0);
    expect(trafficToPct(1)).toBe(100);
    expect(trafficToPct(2)).toBe(100);
    expect(trafficToPct(NaN)).toBe(0);
  });
});

describe("deco_segment round-trip", () => {
  it("round-trips a single active flag", () => {
    const flags: StoredFlag[] = [{ name: "TestHero", value: true, pct: 50 }];
    expect(parseSegmentCookie(serializeSegmentCookie(flags))).toEqual(flags);
  });

  it("round-trips active + inactive flags (sorted by name)", () => {
    const flags: StoredFlag[] = [
      { name: "Zeta", value: false, pct: 20 },
      { name: "Alpha", value: true, pct: 70 },
    ];
    expect(parseSegmentCookie(serializeSegmentCookie(flags))).toEqual([
      { name: "Alpha", value: true, pct: 70 },
      { name: "Zeta", value: false, pct: 20 },
    ]);
  });

  it("produces the classic deco_segment shape that OneDollarStats reads", () => {
    const raw = serializeSegmentCookie([
      { name: "TestHero", value: true, pct: 50 },
      { name: "Promo", value: false, pct: 30 },
    ]);
    // Mirrors @decocms/apps OneDollarStats readFlagsFromCookie decode.
    const seg = JSON.parse(decodeURIComponent(atob(raw)));
    expect(seg.active).toContain("TestHero");
    expect(seg.inactiveDrawn).toContain("Promo");
    expect(seg.pct).toEqual({ TestHero: 50, Promo: 30 });
  });

  it("is raw base64 (no percent-escapes) so atob() works directly", () => {
    const raw = serializeSegmentCookie([{ name: "TestHero", value: true, pct: 50 }]);
    expect(raw).not.toMatch(/%/);
    expect(() => atob(raw)).not.toThrow();
  });
});

describe("parseSegmentCookie robustness", () => {
  it("returns [] for empty / nullish / malformed input", () => {
    expect(parseSegmentCookie(undefined)).toEqual([]);
    expect(parseSegmentCookie(null)).toEqual([]);
    expect(parseSegmentCookie("")).toEqual([]);
    expect(parseSegmentCookie("not-base64-!!!")).toEqual([]);
  });

  it("marks classic segments without a pct fingerprint as pct: -1", () => {
    const raw = btoa(encodeURIComponent(JSON.stringify({ active: ["Legacy"], inactiveDrawn: [] })));
    expect(parseSegmentCookie(raw)).toEqual([{ name: "Legacy", value: true, pct: -1 }]);
  });
});

describe("segmentCacheToken", () => {
  it("is empty for no flags so non-A/B pages share a cache entry", () => {
    expect(segmentCacheToken([])).toBe("");
  });

  it("includes the pct fingerprint so a traffic change re-buckets", () => {
    const at50 = segmentCacheToken([{ name: "TestHero", value: true, pct: 50 }]);
    const at70 = segmentCacheToken([{ name: "TestHero", value: true, pct: 70 }]);
    expect(at50).not.toBe(at70);
  });

  it("differs by decision so cohorts split", () => {
    const on = segmentCacheToken([{ name: "TestHero", value: true, pct: 50 }]);
    const off = segmentCacheToken([{ name: "TestHero", value: false, pct: 50 }]);
    expect(on).not.toBe(off);
  });
});
