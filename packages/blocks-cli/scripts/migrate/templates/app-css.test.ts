import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("uses a custom tailwind.config.ts gray-* override instead of declaring the v3 default gray scale a second time", () => {
    const ctx = createContext("/tmp/does-not-exist");
    ctx.tailwindConfig.colors = { "gray-50": "#111111", "gray-500": "#222222" };

    const css = generateAppCss(ctx);
    const themeBlockMatch = css.match(/@theme \{[\s\S]*?\n\}/);
    expect(themeBlockMatch).not.toBeNull();
    const themeBlock = themeBlockMatch![0];

    // gray-50/500 must be declared exactly once, with the custom value —
    // not once with the custom value and once more with the hardcoded
    // default (which would silently win via CSS's last-declaration-wins).
    expect((themeBlock.match(/--color-gray-50:/g) ?? []).length).toBe(1);
    expect(themeBlock).toContain("--color-gray-50: #111111;");
    expect(themeBlock).not.toContain("--color-gray-50: #f9fafb;");
    expect((themeBlock.match(/--color-gray-500:/g) ?? []).length).toBe(1);
    expect(themeBlock).toContain("--color-gray-500: #222222;");
    // Untouched shades still fall back to the v3 default.
    expect(themeBlock).toContain("--color-gray-950: #030712;");
  });
});

describe("generateAppCss — oklch fixer scope (gotcha #43)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-css-oklch-scope-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not rewrite a hex/oklch(var()) pair declared in the site's own original CSS", () => {
    fs.writeFileSync(
      path.join(tmpDir, "tailwind.css"),
      `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --icon-color: #1a1a1a;
}
.icon {
  fill: oklch(var(--icon-color));
}
`,
      "utf-8",
    );

    const ctx = createContext(tmpDir);
    const css = generateAppCss(ctx);

    // The site's own declaration must survive untouched — the oklch fixer
    // must not reach into content it doesn't own.
    expect(css).toContain("--icon-color: #1a1a1a;");
    expect(css).not.toMatch(/--icon-color:\s*[\d.]+\s+[\d.]+\s+[\d.]+;/);
  });
});

describe("generateAppCss — @apply rewrites classes behind a modifier prefix", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-css-apply-variant-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renames a variant-prefixed class inside @apply, not just bare tokens", () => {
    fs.writeFileSync(
      path.join(tmpDir, "tailwind.css"),
      `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer components {
  .btn-brand {
    @apply md:flex-grow hover:ring rounded;
  }
}
`,
      "utf-8",
    );

    const ctx = createContext(tmpDir);
    const css = generateAppCss(ctx);

    expect(css).toContain("md:grow");
    expect(css).toContain("hover:ring-3");
    expect(css).not.toContain("md:flex-grow");
    expect(css).not.toMatch(/hover:ring(?!-3)/);
  });
});
