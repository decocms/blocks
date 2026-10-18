// @vitest-environment node
/**
 * `@decocms/nextjs/image-loader` against the next/image golden URLs: each
 * Next storefront's current `loaderFile`, run unchanged, over Deco and other
 * sources (`@decocms/blocks`' fixture) and VTEX sources (`@decocms/apps-vtex`'s
 * fixture). The loader is platform-neutral; the site composes the VTEX helpers
 * (`@decocms/apps-vtex/image`) with the Deco CDN itself, as below. This test
 * lives here, not in the package, because `@decocms/nextjs` depends on no
 * `@decocms/apps-*` package, not even for its tests. The only changed cases
 * are the product owner's approved ones (2026-10-14, fix 2: an already-resized
 * Deco CDN URL is re-resized from its src), marked in the fixture with
 * `before` and `reason`. Fix 1 (the store on `via: "query"` moves to
 * `via: "thumbor"`) is a site change: `next-query` still pins the package's
 * `via: "query"` output, unchanged.
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
  before?: unknown;
  reason?: string;
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
    .map((line) => JSON.parse(line) as Case),
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
  it("covers both loaders, from both fixtures, and only fix 2's approved cases changed", () => {
    expect(golden.length).toBeGreaterThan(1000);
    expect(new Set(golden.map((c) => c.config))).toEqual(new Set(Object.keys(LOADERS)));
    const changed = golden.filter((c) => "before" in c);
    expect(changed).toHaveLength(60);
    for (const c of changed) {
      expect(c.src).toMatch(/^https:\/\/(assets\.decocms\.com|decoims\.com)\/image\?/);
      expect(c.reason).toMatch(/^fix 2 \(PO 2026-10-14\)/);
      expect(c.before).toMatch(/&src=image&/);
      expect(c.expected).not.toEqual(c.before);
    }
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
