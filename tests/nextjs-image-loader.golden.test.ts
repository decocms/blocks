// @vitest-environment node
/**
 * `@decocms/nextjs/image-loader` against the next/image golden URLs: each
 * Next storefront's current `loaderFile`, run unchanged, over Deco and other
 * sources (`@decocms/blocks`' fixture) and VTEX sources (`@decocms/apps-vtex`'s
 * fixture). The loader is platform-neutral; the site composes the VTEX helpers
 * (`@decocms/apps-vtex/image`) with the Deco CDN itself, as below. This test
 * lives here, not in the package, because `@decocms/nextjs` depends on no
 * `@decocms/apps-*` package, not even for its tests. No case may change.
 */
import { readFileSync } from "node:fs";
import { vtexCatalogWebp, vtexFileManager } from "@decocms/apps-vtex/image";
import { createImageUrl, decoCdn, type ResizeOptions } from "@decocms/blocks/image";
import { createDecoImageLoader } from "@decocms/nextjs/image-loader";
import { describe, expect, it } from "vitest";

interface Case {
  config: string;
  call: string;
  src: string;
  opts?: ResizeOptions;
  expected: unknown;
}

const FIXTURES = [
  "../packages/blocks/src/v8/__fixtures__/image-golden.jsonl",
  "../packages/apps-vtex/src/__fixtures__/image-golden.jsonl",
];

const LOADERS = { "next-thumbor": "thumbor", "next-query": "query" } as const;

const golden: Case[] = FIXTURES.flatMap((path) =>
  readFileSync(new URL(path, import.meta.url), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Case & { before?: unknown }),
).filter((c) => c.config in LOADERS && c.call === "url");

/** A Next storefront's `loaderFile`, on this package. */
function siteLoader(via: "thumbor" | "query") {
  return createDecoImageLoader(
    createImageUrl({
      providers: [
        vtexCatalogWebp(),
        vtexFileManager({ via }),
        decoCdn({ quality: "high", fit: "contain", layout: "quality-last" }),
      ],
    }),
  );
}

describe("createDecoImageLoader + @decocms/apps-vtex/image: each Next storefront's loader URLs", () => {
  it("covers both loaders, from both fixtures, and no case is a changed URL", () => {
    expect(golden.length).toBeGreaterThan(1000);
    expect(new Set(golden.map((c) => c.config))).toEqual(new Set(Object.keys(LOADERS)));
    expect(golden.filter((c) => "before" in c)).toEqual([]);
  });

  for (const [config, via] of Object.entries(LOADERS)) {
    it(`${config}: byte for byte`, () => {
      const loader = siteLoader(via);
      const mine = golden.filter((c) => c.config === config);
      const diffs = mine
        .map((c) => {
          let got: unknown;
          try {
            got = loader({ src: c.src, width: c.opts!.width!, quality: c.opts!.quality });
          } catch {
            got = "<throws>";
          }
          return { src: c.src, opts: c.opts, expected: c.expected, got };
        })
        .filter((d) => d.got !== d.expected);
      expect(diffs).toEqual([]);
    });
  }
});
