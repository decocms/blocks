/**
 * Scope: `utils/date.ts` — the UTC pinning that makes post ordering and
 * scheduled go-live instants independent of the server's timezone, plus
 * `scheduledTime`'s strict parse.
 *
 * The timezone cases below are the point of the module. They are written by
 * comparing timestamps rather than by mutating `process.env.TZ` mid-run, which
 * V8 caches per-isolate and would not reliably take effect; the repo-level
 * check is `TZ=... bun run test` producing identical output, and the assertions
 * here encode the invariant that makes that true.
 */

import { describe, expect, it } from "vitest";
import { sortPosts } from "../core/handlePosts";
import type { BlogPost } from "../types";
import { dateToTime, scheduledTime } from "../utils/date";

const post = (slug: string, date: string): BlogPost => ({
  title: slug,
  slug,
  date,
  excerpt: "",
});

describe("dateToTime", () => {
  it("reads a bare date as midnight UTC, not midnight local", () => {
    expect(dateToTime("2024-06-01")).toBe(Date.UTC(2024, 5, 1));
  });

  it("pins an offset-less datetime to UTC", () => {
    // Plain `new Date("2024-06-01T00:00:00")` is *local* time — in any zone
    // west of UTC that lands on May 31st, reordering posts across a day
    // boundary depending on which server answered the request.
    expect(dateToTime("2024-06-01T00:00:00")).toBe(Date.UTC(2024, 5, 1));
  });

  it("honours an explicit offset instead of overriding it", () => {
    expect(dateToTime("2024-06-01T00:00:00-03:00")).toBe(Date.UTC(2024, 5, 1, 3));
  });

  it("returns 0 rather than NaN for an unparseable value", () => {
    expect(dateToTime("not a date")).toBe(0);
  });

  it("orders two dates one day apart identically regardless of host offset", () => {
    // Both values are absolute instants, so the comparison cannot shift with
    // the host timezone — this is the property the sort comparator relies on.
    expect(dateToTime("2024-06-02") - dateToTime("2024-06-01")).toBe(24 * 60 * 60 * 1000);
  });
});

describe("sortPosts date ordering is timezone-independent", () => {
  it("keeps day-boundary dates in order", async () => {
    const posts = [
      post("may-31", "2024-05-31"),
      post("jun-02", "2024-06-02"),
      post("jun-01", "2024-06-01"),
    ];
    const sorted = await sortPosts(posts, "date_desc");
    expect(sorted.map((p) => p.slug)).toEqual(["jun-02", "jun-01", "may-31"]);
  });

  it("does not reorder datetimes that differ only by their offset", async () => {
    // Same instant expressed two ways; neither may sort ahead of the other by
    // accident of the host zone.
    const posts = [
      post("utc", "2024-06-01T03:00:00Z"),
      post("offset", "2024-06-01T00:00:00-03:00"),
    ];
    const sorted = await sortPosts(posts, "date_desc");
    expect(dateToTime(sorted[0].date)).toBe(dateToTime(sorted[1].date));
  });

  it("orders a mix of bare dates and full ISO timestamps correctly", async () => {
    // The concrete regression this module fixes: the previous implementation
    // built its timestamp as `new Date(\`${date}T00:00:00\`)`, which yields
    // `Invalid Date` → NaN for any value that already carries a time. A NaN
    // comparison is treated as 0, so every full-ISO post compared "equal" to
    // everything and the listing order became arbitrary.
    const posts = [
      post("bare-old", "2024-01-01"),
      post("iso-newest", "2024-12-01T09:30:00Z"),
      post("bare-mid", "2024-06-01"),
      post("iso-offset", "2024-03-01T00:00:00-03:00"),
    ];
    const sorted = await sortPosts(posts, "date_desc");
    expect(sorted.map((p) => p.slug)).toEqual(["iso-newest", "bare-mid", "iso-offset", "bare-old"]);
  });
});

describe("scheduledTime", () => {
  it("accepts a bare date as midnight UTC", () => {
    expect(scheduledTime("2026-09-01")).toBe(Date.UTC(2026, 8, 1));
  });

  it("accepts a full ISO instant, with or without an offset", () => {
    expect(scheduledTime("2026-09-01T12:30:00Z")).toBe(Date.UTC(2026, 8, 1, 12, 30));
    expect(scheduledTime("2026-09-01T12:30:00-03:00")).toBe(Date.UTC(2026, 8, 1, 15, 30));
  });

  it("rejects a non-ISO string that `Date` would happily parse in local time", () => {
    expect(scheduledTime("Sep 1 2026")).toBeNull();
    // "0" is the year 2000 to `Date` — i.e. already live.
    expect(scheduledTime("0")).toBeNull();
    expect(scheduledTime("")).toBeNull();
  });

  it("rejects calendar overflow instead of rolling it forward", () => {
    expect(scheduledTime("2026-02-31")).toBeNull();
    expect(scheduledTime("2026-13-01")).toBeNull();
    expect(scheduledTime("2026-00-10")).toBeNull();
    expect(scheduledTime("2026-01-00")).toBeNull();
  });

  it("accepts Feb 29 in a leap year and rejects it otherwise", () => {
    expect(scheduledTime("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    expect(scheduledTime("2026-02-29")).toBeNull();
  });

  it("rejects out-of-range times", () => {
    expect(scheduledTime("2026-09-01T24:00:00")).toBeNull();
    expect(scheduledTime("2026-09-01T12:60:00")).toBeNull();
    expect(scheduledTime("2026-09-01T12:00:61")).toBeNull();
  });

  it("rejects an offset that matches the pattern but is not a real instant", () => {
    expect(scheduledTime("2026-09-01T12:00:00+99:00")).toBeNull();
  });

  it("returns null, not 0, on failure — so the epoch stays representable", () => {
    expect(scheduledTime("garbage")).toBeNull();
    expect(scheduledTime("1970-01-01T00:00:00Z")).toBe(0);
  });
});
