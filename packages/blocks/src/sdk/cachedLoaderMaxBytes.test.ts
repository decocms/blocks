import { describe, expect, it } from "vitest";
import { getLoaderCacheMaxBytes, setLoaderCacheMaxBytes } from "./cachedLoader";

describe("loader cache byte cap", () => {
  it("defaults to 32 MB", () => {
    // process.env is empty in workerd unless compatibility_date is new enough,
    // which is exactly why the setter below exists.
    expect(getLoaderCacheMaxBytes()).toBe(32 * 1024 * 1024);
  });

  it("can be raised programmatically", () => {
    setLoaderCacheMaxBytes(64 * 1024 * 1024);
    expect(getLoaderCacheMaxBytes()).toBe(64 * 1024 * 1024);
  });

  it("ignores nonsense instead of disabling eviction", () => {
    setLoaderCacheMaxBytes(64 * 1024 * 1024);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      setLoaderCacheMaxBytes(bad);
      expect(getLoaderCacheMaxBytes()).toBe(64 * 1024 * 1024);
    }
  });
});
