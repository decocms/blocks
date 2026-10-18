// @vitest-environment node
/**
 * `Image`, `Picture` and `Source` from `@decocms/tanstack/react` render v7's
 * markup. `__fixtures__/tanstack-v7-image-markup.jsonl` was rendered by v7's
 * own components (`@decocms/blocks` 7.x `hooks/Image.tsx` and
 * `hooks/Picture.tsx`) over a set of sources and props, once with v7's
 * defaults and once with `registerImageCdnDomain("decoims.com")` plus
 * `registerImageQuality("high")`. Each must come out byte for byte.
 *
 * The package knows no commerce platform, so the test supplies the URLs the
 * way a site does: VTEX's and Shopify's helpers (`@decocms/apps-vtex/image`,
 * `@decocms/apps-shopify/image`) listed before the Deco CDN in its own
 * `createImageUrl`, under an `ImageUrlProvider`. It lives here, not in the
 * package, because `@decocms/tanstack` depends on no `@decocms/apps-*`
 * package, not even for its tests.
 */
import { readFileSync } from "node:fs";
import { shopifyCdn } from "@decocms/apps-shopify/image";
import { vtexCatalog } from "@decocms/apps-vtex/image";
import { createImageUrl, decoCdn, type ImageProvider, type ImageUrl } from "@decocms/blocks/image";
import { Image, ImageUrlProvider, Picture, Source } from "@decocms/tanstack/react";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface Case {
  config: "default" | "decoims-high";
  kind: "Image" | "Picture" | "PictureNoWidth";
  src: string;
  props: Record<string, unknown>;
  html: string;
}

const fixture = (name: string): Case[] =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const cases = fixture("tanstack-v7-image-markup.jsonl");
/**
 * Rendered by the same v7 components (7.x `hooks/Image.tsx`, `hooks/Picture.tsx`):
 * `Image`s and `Source`s without a width (v7 wrote `width=NaN … NaNw`
 * candidates) and Nuvemshop product images (v7 picked one of the CDN's fixed
 * sizes by a filename suffix).
 */
const extra = fixture("tanstack-v7-image-markup-nowidth-nuvemshop.jsonl");

/**
 * A Nuvemshop store's own provider, as `reference/framework-code.md` in the
 * migration skill gives it: no `@decocms/apps-*` package covers Nuvemshop, so
 * the site keeps v7's rule in its `src/imageUrl.ts`.
 */
const NUVEMSHOP_IMAGE =
  /^(https:\/\/[a-z0-9-]+\.mitiendanube\.com\/stores\/.+\/products\/.+)-\d+-\d+\.(\w+)$/;
const NUVEMSHOP_SIZES = [50, 100, 240, 320, 480, 640];
const nuvemshop: ImageProvider = {
  name: "nuvemshop",
  match: (src) => NUVEMSHOP_IMAGE.test(src),
  format(src, { width }) {
    const m = src.match(NUVEMSHOP_IMAGE);
    if (!m) return null;
    const size = NUVEMSHOP_SIZES.find((s) => s >= width);
    return `${m[1]}-${size ? `${size}-0` : "1024-1024"}.${m[2]}`;
  },
};

/** A site's `src/imageUrl.ts`, for each v7 configuration. */
const SITE: Record<Case["config"], ImageUrl> = {
  default: createImageUrl({
    providers: [vtexCatalog(), shopifyCdn(), decoCdn({ sources: "all" })],
  }),
  "decoims-high": createImageUrl({
    providers: [
      vtexCatalog(),
      shopifyCdn(),
      decoCdn({ domain: "decoims.com", quality: "high", sources: "all" }),
    ],
  }),
};

function tree(c: Case): ReactElement {
  if (c.kind === "Image") return createElement(Image, { src: c.src, ...c.props } as never);
  const { src } = c;
  if (c.kind === "PictureNoWidth") {
    const nuvem = src.includes("mitiendanube");
    return createElement(
      Picture,
      { preload: c.props.preload as boolean, className: "block" } as never,
      createElement(Source, { media: "(max-width: 767px)", src, height: 280 } as never),
      createElement(Source, {
        media: "(min-width: 768px)",
        src,
        width: nuvem ? 1280 : undefined,
      } as never),
      createElement(Image, { src, alt: "x" } as never),
    );
  }
  return createElement(
    Picture,
    { preload: c.props.preload as boolean, className: "block" } as never,
    createElement(Source, { media: "(max-width: 767px)", src, width: 320, height: 280 }),
    createElement(Source, {
      media: "(min-width: 768px)",
      src,
      width: 1280,
      height: 280,
      fetchPriority: "low",
    }),
    createElement(Source, { media: "print", src, width: 640, srcSet: "p.png" }),
    createElement(Image, { src, width: 1280, height: 280, alt: "x" }),
  );
}

function diffs(list: Case[], wrap: (c: Case, el: ReactElement) => ReactElement) {
  return list
    .map((c) => ({ c, got: renderToStaticMarkup(wrap(c, tree(c))) }))
    .filter(({ c, got }) => got !== c.html)
    .map(({ c, got }) => ({ config: c.config, src: c.src, props: c.props, expected: c.html, got }));
}

// React warns about the empty `src` cases, as it did for v7's components.
let errors: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => errors.mockRestore());

describe("v7's markup, byte for byte", () => {
  it("covers both configs, Image and Picture (160 cases)", () => {
    expect(cases).toHaveLength(160);
    expect(new Set(cases.map((c) => `${c.config}/${c.kind}`))).toEqual(
      new Set(["default/Image", "default/Picture", "decoims-high/Image", "decoims-high/Picture"]),
    );
  });

  it("with the site's ImageUrlProvider (VTEX and Shopify helpers, then the Deco CDN)", () => {
    expect(
      diffs(cases, (c, el) => createElement(ImageUrlProvider, { value: SITE[c.config] }, el)),
    ).toEqual([]);
  });

  it("without a width, and Nuvemshop images with the store's own provider (90 cases)", () => {
    expect(extra).toHaveLength(90);
    const site: Record<Case["config"], ImageUrl> = {
      default: createImageUrl({
        providers: [vtexCatalog(), shopifyCdn(), nuvemshop, decoCdn({ sources: "all" })],
      }),
      "decoims-high": createImageUrl({
        providers: [
          vtexCatalog(),
          shopifyCdn(),
          nuvemshop,
          decoCdn({ domain: "decoims.com", quality: "high", sources: "all" }),
        ],
      }),
    };
    expect(
      diffs(extra, (c, el) => createElement(ImageUrlProvider, { value: site[c.config] }, el)),
    ).toEqual([]);
  });

  it("with no provider, every source that isn't a VTEX or Shopify image: v7's defaults", () => {
    const neutral = cases.filter(
      (c) => c.config === "default" && !/vtexassets|cdn\.shopify\.com/.test(c.src),
    );
    expect(neutral.length).toBeGreaterThan(0);
    expect(diffs(neutral, (_c, el) => el)).toEqual([]);
  });
});
