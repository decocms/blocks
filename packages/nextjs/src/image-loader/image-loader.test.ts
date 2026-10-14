// @vitest-environment node
/**
 * The loader over an `ImageUrl` from `@decocms/blocks/image`. It knows no
 * commerce platform: a site adds its platform's helpers
 * (`@decocms/apps-vtex/image`, ...) to the `ImageUrl` it passes. The next/image
 * golden URLs, run through that composition, are checked in
 * `tests/nextjs-image-loader.golden.test.ts` (this package depends on no
 * `@decocms/apps-*`).
 */
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { describe, expect, it } from "vitest";
import { createDecoImageLoader, nextImageOptimizer } from "./index.ts";

/** The Deco CDN as the next/image storefronts call it. */
const imageUrl = createImageUrl({
  providers: [decoCdn({ quality: "high", fit: "contain", layout: "quality-last" })],
});

describe("createDecoImageLoader", () => {
  it("a source the ImageUrl resizes: its URL, with the width and quality next/image passes", () => {
    const src = "https://assets.decocache.com/acme/1a2b/hero.jpg";
    const loader = createDecoImageLoader(imageUrl);
    expect(loader({ src, width: 640, quality: 75 })).toBe(
      imageUrl(src, { width: 640, quality: 75 }),
    );
    expect(loader({ src, width: 640 })).toBe(imageUrl(src, { width: 640 }));
    expect(loader({ src, width: 640 })).not.toBe(src);
  });

  it("an unknown source: unchanged, or the fallback's URL", () => {
    const local = { src: "/static/hero.jpg", width: 640, quality: 75 };
    expect(createDecoImageLoader(imageUrl)(local)).toBe("/static/hero.jpg");
    expect(createDecoImageLoader(imageUrl, { fallback: nextImageOptimizer })(local)).toBe(
      "/_next/image?url=%2Fstatic%2Fhero.jpg&w=640&q=75",
    );
    expect(createDecoImageLoader(imageUrl, { fallback: () => null })(local)).toBe(
      "/static/hero.jpg",
    );
  });

  it("nextImageOptimizer: Next's own URL, a named tier as its number, no q without a quality", () => {
    expect(nextImageOptimizer({ src: "https://img.example.com/a.png", width: 96 })).toBe(
      "/_next/image?url=https%3A%2F%2Fimg.example.com%2Fa.png&w=96",
    );
    expect(nextImageOptimizer({ src: "/a.png", width: 96, quality: "high" })).toBe(
      "/_next/image?url=%2Fa.png&w=96&q=80",
    );
  });
});
