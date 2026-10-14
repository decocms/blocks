// @vitest-environment node
/**
 * `Image`, `Picture` and `Source` render v7's markup. `__fixtures__/v7-image-markup.jsonl`
 * was rendered by v7's own components (`@decocms/blocks` 7.x `hooks/Image.tsx`
 * and `hooks/Picture.tsx`) over a set of sources and props, once with v7's
 * defaults and once with `registerImageCdnDomain("decoims.com")` plus
 * `registerImageQuality("high")`. Each must come out byte for byte, with the
 * matching `ImageUrl` in place of v7's module state.
 */
import { readFileSync } from "node:fs";
import { createImageUrl, decoCdn, shopify, vtexCatalog } from "@decocms/blocks/image";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Image, ImageUrlProvider, Picture, Source, useImageUrl, V7_IMAGE_URL } from "./index.ts";

interface Case {
  config: "default" | "decoims-high";
  kind: "Image" | "Picture";
  src: string;
  props: Record<string, unknown>;
  html: string;
}

const cases: Case[] = readFileSync(
  new URL("./__fixtures__/v7-image-markup.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const decoimsHigh = createImageUrl({
  providers: [
    vtexCatalog({ size: "exact" }),
    shopify(),
    decoCdn({ domain: "decoims.com", quality: "high", proxyOtherHosts: true }),
  ],
});

function tree(c: Case): ReactElement {
  if (c.kind === "Image") return createElement(Image, { src: c.src, ...c.props } as never);
  const { src } = c;
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

// React warns about the empty `src` cases, as it did for v7's components.
let errors: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => errors.mockRestore());

describe("v7's markup, byte for byte", () => {
  it("covers both configs, Image and Picture", () => {
    expect(new Set(cases.map((c) => `${c.config}/${c.kind}`))).toEqual(
      new Set(["default/Image", "default/Picture", "decoims-high/Image", "decoims-high/Picture"]),
    );
  });

  it("with no provider: v7's defaults", () => {
    const diffs = cases
      .filter((c) => c.config === "default")
      .map((c) => ({ c, got: renderToStaticMarkup(tree(c)) }))
      .filter(({ c, got }) => got !== c.html)
      .map(({ c, got }) => ({ src: c.src, props: c.props, expected: c.html, got }));
    expect(diffs).toEqual([]);
  });

  it("with an ImageUrlProvider: the site's CDN host and quality", () => {
    const diffs = cases
      .filter((c) => c.config === "decoims-high")
      .map((c) => ({
        c,
        got: renderToStaticMarkup(createElement(ImageUrlProvider, { value: decoimsHigh }, tree(c))),
      }))
      .filter(({ c, got }) => got !== c.html)
      .map(({ c, got }) => ({ src: c.src, props: c.props, expected: c.html, got }));
    expect(diffs).toEqual([]);
  });
});

describe("the provider", () => {
  it("useImageUrl gives v7's defaults without a provider, and the provider's value under one", () => {
    let seen: unknown;
    const Probe = () => {
      seen = useImageUrl();
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(V7_IMAGE_URL);
    renderToStaticMarkup(
      createElement(ImageUrlProvider, { value: decoimsHigh }, createElement(Probe)),
    );
    expect(seen).toBe(decoimsHigh);
  });

  it("resizes an already-resized Deco CDN URL from its source (v7 produced src=image)", () => {
    const html = renderToStaticMarkup(
      createElement(Image, {
        src: "https://decoims.com/image?fit=cover&width=200&src=a-storefront/x.png",
        width: 300,
        height: 200,
      }),
    );
    expect(html).toContain(
      'src="https://assets.decocms.com/image?fit=cover&amp;width=300&amp;height=200&amp;src=a-storefront/x.png"',
    );
  });

  it("never warns about a missing height", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderToStaticMarkup(createElement(Image, { src: "/a.png", width: 10 }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
