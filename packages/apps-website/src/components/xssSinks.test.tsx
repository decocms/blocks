import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Seo from "./Seo";
import Theme from "./Theme";

// Regression: these components emit CMS-configurable values into inline
// <script>/<style> bodies. Attacker-influenceable content must never break out.

const SCRIPT_INJECT = "<script>alert(document.domain)</script>";

describe("Seo — JSON-LD script sink", () => {
  it("does not let a jsonLDs value break out of the ld+json script", () => {
    const html = renderToStaticMarkup(
      <Seo jsonLDs={[{ name: `</script>${SCRIPT_INJECT}` }]} />,
    );
    expect(html).not.toContain(SCRIPT_INJECT);
    expect(html).not.toContain("</script><script>");
  });
});

describe("Theme — <style> sink", () => {
  it("does not let a design-token value break out of the <style> tag", () => {
    const html = renderToStaticMarkup(
      <Theme variables={[{ name: "--x", value: `red}</style>${SCRIPT_INJECT}` }]} />,
    );
    expect(html).not.toContain(SCRIPT_INJECT);
    // The injected closing tag must be escaped; the only </style> allowed is the
    // component's own real terminator, never one followed by injected markup.
    expect(html).not.toContain("</style><script>");
  });
});

// Note: GoogleTagManager is NOT tested here — its trackingId flows through
// `new URL(...).href`, which percent-encodes quotes/`<`/`>` (verified: `'` -> %27),
// so it cannot break out of the inline JS string. GTAG additionally sanitizes.
