import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The component only needs the router's isLoading flag.
let isLoading = true;
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { isLoading: boolean }) => unknown }) =>
    select({ isLoading }),
}));

const { NavigationProgress } = await import("./NavigationProgress");

/**
 * The bug this guards: the bar used to be painted with the Tailwind utility
 * `bg-brand-primary-500`. That token is a *site* concern — framework code
 * cannot assume it exists. On a Tailwind v4 theme that resets
 * `--color-*: initial` the utility is never generated, so the class resolves to
 * nothing and the bar is fully transparent: an invisible progress indicator, in
 * production, with no build error and nothing in the console.
 *
 * The fix is to paint via inline style / `currentColor`, which cannot be
 * elided by a CSS build. Asserting on the absence of a brand class is what
 * makes the regression loud.
 */
describe("NavigationProgress — visibility does not depend on site color tokens", () => {
  it("paints via inline style, not a site-defined Tailwind color utility", () => {
    isLoading = true;
    const html = renderToStaticMarkup(<NavigationProgress />);

    expect(html).not.toMatch(/bg-brand-/);
    // Both the track and the moving bar carry a real, resolvable color.
    expect(html.match(/background-color:\s*currentColor/g)).toHaveLength(2);
    expect(html).toContain("color:currentColor");
  });

  it("accepts an explicit color so a site can brand it without a utility class", () => {
    isLoading = true;
    const html = renderToStaticMarkup(<NavigationProgress color="#ff0080" />);
    expect(html).toContain("color:#ff0080");
  });

  it("renders nothing when the router is idle", () => {
    isLoading = false;
    expect(renderToStaticMarkup(<NavigationProgress />)).toBe("");
  });
});
