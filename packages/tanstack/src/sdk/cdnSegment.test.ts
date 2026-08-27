import { describe, expect, it } from "vitest";
import { segmentToken } from "./cdnSegment";

const BUILD = "abc123";

describe("segmentToken", () => {
  it("anonymous: token is device.build", () => {
    expect(segmentToken({ device: "mobile" }, BUILD)).toBe("mobile.abc123");
    expect(segmentToken({ device: "desktop" }, BUILD)).toBe("desktop.abc123");
    // tablet is its own detectDevice value — it must not collapse into mobile
    expect(segmentToken({ device: "tablet" }, BUILD)).toBe("tablet.abc123");
  });

  it("mobile and desktop never share a token", () => {
    expect(segmentToken({ device: "mobile" }, BUILD)).not.toBe(
      segmentToken({ device: "desktop" }, BUILD),
    );
  });

  it("personalization disables CDN caching", () => {
    expect(segmentToken({ device: "mobile", loggedIn: true }, BUILD)).toBeNull();
    expect(segmentToken({ device: "mobile", regionId: "v2.XYZ" }, BUILD)).toBeNull();
    expect(segmentToken({ device: "mobile", salesChannel: "3" }, BUILD)).toBeNull();
  });

  it("an unknown custom dimension fails closed", () => {
    // A site adding its own SegmentKey field must not silently share entries
    // across that dimension.
    expect(segmentToken({ device: "mobile", storeId: "sp-01" }, BUILD)).toBeNull();
    expect(segmentToken({ device: "mobile", flags: ["promo"] }, BUILD)).toBeNull();
  });

  it("empty-ish custom values do not disable caching", () => {
    // These carry no dimension — hashSegment skips them too, so the Worker key
    // is identical with or without them.
    expect(segmentToken({ device: "mobile", storeId: "" }, BUILD)).toBe("mobile.abc123");
    expect(segmentToken({ device: "mobile", beta: false }, BUILD)).toBe("mobile.abc123");
    expect(segmentToken({ device: "mobile", flags: [] }, BUILD)).toBe("mobile.abc123");
    expect(segmentToken({ device: "mobile", loggedIn: undefined }, BUILD)).toBe("mobile.abc123");
  });

  it("missing or dev build hash disables CDN caching", () => {
    // without a build hash there is no way to invalidate on deploy — the CDN
    // would serve stale code
    expect(segmentToken({ device: "mobile" }, undefined)).toBeNull();
    expect(segmentToken({ device: "mobile" }, "")).toBeNull();
    expect(segmentToken({ device: "mobile" }, "dev")).toBeNull();
  });

  it("a different build yields a different token (invalidates on deploy)", () => {
    expect(segmentToken({ device: "mobile" }, "buildA")).not.toBe(
      segmentToken({ device: "mobile" }, "buildB"),
    );
  });
});
