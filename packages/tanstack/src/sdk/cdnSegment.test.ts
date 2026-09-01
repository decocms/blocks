import { describe, expect, it } from "vitest";
import { segmentToken } from "./cdnSegment";

const BUILD = "abc123";

describe("segmentToken", () => {
  it("produces a token for an anonymous visitor", () => {
    expect(segmentToken("desktop", false, BUILD)).toBeTruthy();
  });

  it("gives different segments different tokens", () => {
    // The whole point: the URL has to distinguish what the Worker's key
    // distinguishes, or a cache in front serves one visitor another's response.
    const tokens = ["desktop", "mobile", "desktop|r=RJ", "desktop|r=SP", "desktop|sc=3|r=RJ"].map(
      (s) => segmentToken(s, false, BUILD),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("regionalized and non-regionalized visitors never share a token", () => {
    // This is the case that made the first version inert on real stores: region
    // is resolved server-side from cf.regionCode, so it MUST be in the token.
    expect(segmentToken("desktop", false, BUILD)).not.toBe(
      segmentToken("desktop|r=RJ", false, BUILD),
    );
  });

  it("is stable for the same segment and build", () => {
    // The worker verifies by recomputing, so the same input must always give
    // the same token — otherwise nothing would ever match.
    expect(segmentToken("desktop|r=RJ", false, BUILD)).toBe(
      segmentToken("desktop|r=RJ", false, BUILD),
    );
  });

  it("refuses a logged-in visitor regardless of segment precision", () => {
    // Personalized responses never belong in a shared entry, however exact the
    // key is.
    expect(segmentToken("desktop|auth|r=RJ", true, BUILD)).toBeNull();
  });

  it("refuses a missing or dev build hash", () => {
    // Without a build hash there is no way to invalidate on deploy — the cache
    // in front would keep serving stale code.
    expect(segmentToken("desktop", false, undefined)).toBeNull();
    expect(segmentToken("desktop", false, "")).toBeNull();
    expect(segmentToken("desktop", false, "dev")).toBeNull();
  });

  it("changes with the build, so a deploy invalidates it", () => {
    expect(segmentToken("desktop", false, "buildA")).not.toBe(
      segmentToken("desktop", false, "buildB"),
    );
  });

  it("refuses an empty segment descriptor", () => {
    expect(segmentToken("", false, BUILD)).toBeNull();
  });

  it("is URL-safe even when the segment carries a VTEX region id", () => {
    // `v2.XXXX` contains the character an earlier format used as a separator;
    // hashing sidesteps escaping entirely.
    const t = segmentToken("desktop|r=v2.ABC-123|sc=3", false, BUILD);
    expect(t).toMatch(/^[a-z0-9]+$/);
    expect(encodeURIComponent(t as string)).toBe(t);
  });
});
