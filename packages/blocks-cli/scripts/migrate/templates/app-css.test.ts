import { describe, expect, it } from "vitest";
import { createContext } from "../types";
import { generateAppCss } from "./app-css";

describe("generateAppCss — tailwind.config.ts porting", () => {
  it("emits custom colors, fonts, and breakpoints ported from tailwind.config.ts", () => {
    const ctx = createContext("/tmp/does-not-exist");
    ctx.tailwindConfig = {
      colors: { perola: "#F5F0E8", "brand-500": "#B10200" },
      fontFamily: { "bebas-neue": "Bebas Neue, sans-serif" },
      screens: { "3xl": "1920px" },
      safelist: ["bg-red-500", "text-brand-500"],
      safelistPatterns: [],
      plugins: [],
      reviewItems: [],
    };

    const css = generateAppCss(ctx);

    expect(css).toContain("--color-perola: #F5F0E8;");
    expect(css).toContain("--color-brand-500: #B10200;");
    expect(css).toContain("--font-bebas-neue: Bebas Neue, sans-serif;");
    expect(css).toContain("--breakpoint-3xl: 1920px;");
    expect(css).toContain('@source inline("bg-red-500 text-brand-500");');
  });

  it("does not duplicate a custom color that collides with a daisyUI semantic key", () => {
    const ctx = createContext("/tmp/does-not-exist");
    ctx.tailwindConfig.colors = { primary: "#000000" };

    const css = generateAppCss(ctx);
    // The daisyUI theme's own --color-primary is emitted once in the plugin
    // block; the ported tailwind.config.ts value must not add a second,
    // conflicting @theme declaration.
    const themeBlockMatch = css.match(/@theme \{[\s\S]*?\n\}/);
    expect(themeBlockMatch).not.toBeNull();
    const occurrences = (themeBlockMatch![0].match(/--color-primary:/g) ?? []).length;
    expect(occurrences).toBe(0);
  });

  it("flags unconvertible safelist regex patterns as manual review items", () => {
    const ctx = createContext("/tmp/does-not-exist");
    ctx.tailwindConfig.safelistPatterns = ["/^grid-cols-/"];

    generateAppCss(ctx);

    expect(
      ctx.manualReviewItems.some((i) => i.reason.includes("/^grid-cols-/")),
    ).toBe(true);
  });
});
