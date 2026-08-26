import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductJsonLd } from "./JsonLd";
import { LiveControls } from "./LiveControls";

// Regression: these components emit attacker-influenceable data into inline
// <script> bodies. A value containing `</script>` must never break out of the
// tag. Asserting on the rendered HTML is the only faithful check — tsc and the
// component's types don't catch it (React does not escape dangerouslySetInnerHTML).

const BREAKOUT = "</script><script>alert(document.domain)</script>";
const INJECTED = "<script>alert(document.domain)</script>";

describe("ProductJsonLd — JSON-LD script sink", () => {
  it("does not let a product name break out of the ld+json script", () => {
    const html = renderToStaticMarkup(<ProductJsonLd product={{ name: BREAKOUT }} />);
    expect(html).not.toContain(INJECTED);
    expect(html).not.toContain("</script><script>");
  });
});

describe("LiveControls — __DECO_STATE script sink", () => {
  it("does not let a page pathTemplate break out of the state script", () => {
    const html = renderToStaticMarkup(
      <LiveControls site="s" page={{ id: "p", pathTemplate: BREAKOUT }} />,
    );
    expect(html).not.toContain(INJECTED);
    expect(html).not.toContain("</script><script>");
  });
});
