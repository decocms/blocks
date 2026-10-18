/**
 * `SegmentCookie`'s browser half: after a client-side navigation React
 * renders the page itself and runs no `<script>` it renders, so the effect
 * writes the cookie. Same `Set-Cookie` value as the inline script.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentCookieWriter } from "./SegmentCookieWriter.ts";
import { segmentCookieScript } from "./shared.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: clears the cookie the test wrote
  document.cookie = "deco_segment=; Max-Age=0; Path=/";
  document.body.innerHTML = "";
});

describe("SegmentCookieWriter", () => {
  it("server render: the inline script, with the nonce", () => {
    const setCookie = "deco_segment=eyJhIjoxfQ==; Max-Age=31536000; Path=/; SameSite=Lax";
    expect(
      renderToStaticMarkup(createElement(SegmentCookieWriter, { setCookie, nonce: "n1" })),
    ).toBe(`<script nonce="n1">${segmentCookieScript(setCookie)}</script>`);
  });

  it("client-side navigation: the effect writes the cookie", async () => {
    const setCookie = "deco_segment=eyJhIjoxfQ==; Max-Age=31536000; Path=/; SameSite=Lax";
    expect(document.cookie).not.toContain("deco_segment");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(SegmentCookieWriter, { setCookie })));
    expect(document.cookie).toContain("deco_segment=eyJhIjoxfQ==");
    await act(async () => root.unmount());
  });
});
