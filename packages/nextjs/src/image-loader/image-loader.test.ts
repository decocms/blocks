// @vitest-environment node
/**
 * The loader against the next/image golden URLs of `@decocms/blocks/image`
 * (each Next storefront's current loader, byte for byte): the URL a site's
 * `loaderFile` returns must not change when it moves to this package.
 */
import { readFileSync } from "node:fs";
import {
  createImageUrl,
  decoCdn,
  type ResizeOptions,
  vtexCatalog,
  vtexFileManager,
} from "@decocms/blocks/image";
import { describe, expect, it } from "vitest";
import { createDecoImageLoader, nextImageOptimizer } from "./index.ts";

interface Case {
  config: string;
  call: string;
  src: string;
  opts?: ResizeOptions;
  expected: unknown;
}

const golden: Case[] = readFileSync(
  new URL("../../../blocks/src/v8/__fixtures__/image-golden.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter(
    (c: Case) => (c.config === "next-thumbor" || c.config === "next-query") && c.call === "url",
  );

/** The next/image storefronts' ImageUrl (as in `@decocms/blocks`' golden test). */
const imageUrl = createImageUrl({
  providers: [
    vtexCatalog({ size: "auto", format: "webp", quality: 8, anyHost: true }),
    vtexFileManager({ via: "thumbor", quality: 8 }),
    decoCdn({ quality: "high", layout: "quality-last" }),
  ],
});

describe("createDecoImageLoader", () => {
  it("reproduces the storefronts' loader URLs byte for byte", () => {
    expect(golden.length).toBeGreaterThan(100);
    const loader = createDecoImageLoader(imageUrl);
    const diffs = golden
      .map((c) => ({
        src: c.src,
        opts: c.opts,
        expected: c.expected,
        got: loader({ src: c.src, width: c.opts!.width, quality: c.opts!.quality }),
      }))
      .filter((d) => d.got !== d.expected);
    expect(diffs).toEqual([]);
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
