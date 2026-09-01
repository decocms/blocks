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
 * The fix paints through an inline custom-property expression, which a CSS build
 * cannot elide. It has to satisfy BOTH directions at once: sites that never
 * defined the token must still see a bar, and sites that DID must keep their
 * brand color rather than silently dropping to black — hence the var-with-
 * fallback rather than a bare `currentColor`.
 */
describe("NavigationProgress — visibility does not depend on site color tokens", () => {
  it("paints via inline style, never a site-defined Tailwind color utility", () => {
    isLoading = true;
    const html = renderToStaticMarkup(<NavigationProgress />);

    expect(html).not.toMatch(/bg-brand-/);
    expect(html).toMatch(/background-color:\s*currentColor/);
  });

  it("keeps the brand token when the site defines it, and falls back when it does not", () => {
    isLoading = true;
    const html = renderToStaticMarkup(<NavigationProgress />);

    // Both halves matter: the var preserves branding for sites where the old
    // utility worked, the fallback is what makes it visible for those where it
    // silently did not.
    expect(html).toContain("--color-brand-primary-500");
    expect(html).toMatch(/var\(--color-brand-primary-500,\s*currentColor\)/);
  });

  it("accepts an explicit color so a site can brand it without that token name", () => {
    isLoading = true;
    const html = renderToStaticMarkup(<NavigationProgress color="#ff0080" />);
    expect(html).toContain("#ff0080");
    expect(html).not.toContain("--color-brand-primary-500");
  });

  it("renders nothing when the router is idle", () => {
    isLoading = false;
    expect(renderToStaticMarkup(<NavigationProgress />)).toBe("");
  });
});
