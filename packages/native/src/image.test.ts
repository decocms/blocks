import { afterEach, describe, expect, it, vi } from "vitest";
import { optimizedImageUrl, prefetchImages, resetImageBackend, setImageBackend } from "./image";

afterEach(() => resetImageBackend());

describe("optimizedImageUrl", () => {
  it("resizes a Shopify image with that CDN's own syntax", () => {
    // 1.34 MB original against 79 KB at width=480, measured on a real store.
    const url = optimizedImageUrl(
      "https://cdn.shopify.com/s/files/1/0584/1338/3857/files/kidssweatwhite2.png?v=1720563225",
      160,
      192,
    );
    expect(url).toContain("width=");
    expect(url).toContain("crop=center");
  });

  it("rewrites a deco CDN image through its image endpoint", () => {
    // The trap: `?width=` on decoims does NOTHING and returns the full
    // original, with no error. The working form is `/image?...&src=`.
    const url = optimizedImageUrl("https://decoims.com/site/abc/photo.jpg", 390, 666);
    expect(url).toContain("decoims.com/image?");
    expect(url).toContain("src=");
    expect(url).toMatch(/width=\d+/);
  });

  it("scales by device density, capped at 3", () => {
    // An iPhone Pro is @3x; asking for @4 doubles the payload for no visible
    // gain. Under vitest PixelRatio.get() is 1, so this asserts the floor.
    const url = optimizedImageUrl("https://cdn.shopify.com/s/files/a.png", 100);
    const width = Number(new URL(url).searchParams.get("width"));
    expect(width).toBeGreaterThanOrEqual(100);
    expect(width).toBeLessThanOrEqual(300);
  });

  it("returns the original when the source is unknown to every CDN", () => {
    // Better an unoptimised image than a broken one.
    expect(optimizedImageUrl("https://example.com/a.png", 100)).toBeTruthy();
  });
});

describe("prefetchImages", () => {
  it("warms exactly the URLs the render will ask for", () => {
    // The bug this guards: a prefetch that computes its own size warms a cache
    // entry nobody requests — and looks like it is working.
    const prefetch = vi.fn();
    setImageBackend({ Image: (() => null) as never, prefetch });

    const src = "https://cdn.shopify.com/s/files/1/0584/1338/3857/files/a.png";
    prefetchImages([src], 160, 192);

    expect(prefetch).toHaveBeenCalledWith([optimizedImageUrl(src, 160, 192)]);
  });

  it("is a no-op without a backend", () => {
    // An app with no image cache gains nothing from downloading early, and must
    // not crash for trying.
    expect(() => prefetchImages(["https://cdn.shopify.com/s/files/a.png"], 100)).not.toThrow();
  });

  it("skips empty sources instead of warming a broken URL", () => {
    const prefetch = vi.fn();
    setImageBackend({ Image: (() => null) as never, prefetch });
    prefetchImages([undefined, undefined], 100);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("survives a backend that rejects", () => {
    const prefetch = vi.fn(() => Promise.reject(new Error("offline")));
    setImageBackend({ Image: (() => null) as never, prefetch });
    expect(() => prefetchImages(["https://cdn.shopify.com/s/files/a.png"], 100)).not.toThrow();
  });
});
