// @vitest-environment node
/**
 * The image components' own behaviour. v7's markup, byte for byte over 160
 * cases, is checked in `tests/tanstack-image-markup.golden.test.ts`, with the
 * VTEX and Shopify helpers a site supplies (this package depends on no
 * `@decocms/apps-*` package).
 */
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DECO_IMAGE_URL, Image, ImageUrlProvider, useImageUrl } from "./index.ts";

const decoimsHigh = createImageUrl({
  providers: [decoCdn({ domain: "decoims.com", quality: "high", sources: "all" })],
});

describe("no platform knowledge", () => {
  it("without a provider, a VTEX catalog image goes through the Deco CDN like any other source", () => {
    const html = renderToStaticMarkup(
      createElement(Image, {
        src: "https://a-store.vtexassets.com/arquivos/ids/155392-800-800/shirt.jpg",
        width: 300,
        height: 300,
      }),
    );
    expect(html).toContain(
      'src="https://assets.decocms.com/image?fit=cover&amp;width=300&amp;height=300&amp;src=',
    );
  });

  it("a site's provider decides the URL", () => {
    const html = renderToStaticMarkup(
      createElement(
        ImageUrlProvider,
        { value: decoimsHigh },
        createElement(Image, { src: "/static/hero.png", width: 100, height: 50 }),
      ),
    );
    expect(html).toContain(
      'src="https://decoims.com/image?fit=cover&amp;width=100&amp;height=50&amp;quality=high&amp;src=/static/hero.png"',
    );
  });
});

describe("the provider", () => {
  it("useImageUrl gives DECO_IMAGE_URL without a provider, and the provider's value under one", () => {
    let seen: unknown;
    const Probe = () => {
      seen = useImageUrl();
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(DECO_IMAGE_URL);
    renderToStaticMarkup(
      createElement(ImageUrlProvider, { value: decoimsHigh }, createElement(Probe)),
    );
    expect(seen).toBe(decoimsHigh);
  });

  it("never warns about a missing height", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderToStaticMarkup(createElement(Image, { src: "/a.png", width: 10 }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
