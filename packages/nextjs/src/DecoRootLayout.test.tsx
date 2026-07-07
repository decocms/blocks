import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecoRootLayout } from "./DecoRootLayout";

describe("DecoRootLayout (next)", () => {
  it("renders the html shell with LiveControls and the analytics bootstrap script", () => {
    const html = renderToString(
      <DecoRootLayout siteName="test-site">
        <div>page content</div>
      </DecoRootLayout>,
    );
    expect(html).toContain("page content");
    expect(html).toContain("__DECO_STATE");
    // "window.DECO" alone is a false-positive trap: it also appears twice in
    // this component's own inline bootstrap script (buildDecoEventsBootstrap's
    // `window.DECO = window.DECO || {}` and `window.DECO.events = ...`), so it
    // would still pass even if the ANALYTICS_SCRIPT <script> tag were deleted
    // entirely. "IntersectionObserver" only exists inside ANALYTICS_SCRIPT
    // (packages/blocks/src/sdk/analytics.ts) — it genuinely pins that script.
    expect(html).toContain("IntersectionObserver");
  });
});
