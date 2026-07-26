import { describe, expect, it } from "vitest";
import { promoteApplyClassesToUtility, rewriteThemeHelper, transformCss } from "./css";

describe("rewriteThemeHelper", () => {
  it("rewrites theme(colors.x.y) to var(--color-x-y)", () => {
    const r = rewriteThemeHelper(".foo { color: theme(colors.gray.100); }");
    expect(r.css).toBe(".foo { color: var(--color-gray-100); }");
    expect(r.notes.length).toBe(1);
  });

  it("rewrites theme(spacing.4) to var(--spacing-4)", () => {
    const r = rewriteThemeHelper(".foo { margin: theme(spacing.4); }");
    expect(r.css).toBe(".foo { margin: var(--spacing-4); }");
  });

  it("preserves a fallback second argument", () => {
    const r = rewriteThemeHelper(".foo { color: theme(colors.gray.100, #fff); }");
    expect(r.css).toBe(".foo { color: var(--color-gray-100, #fff); }");
  });

  it("leaves a bare theme() call without a dotted path untouched", () => {
    const r = rewriteThemeHelper(".foo { color: theme(primary); }");
    expect(r.css).toBe(".foo { color: theme(primary); }");
  });
});

describe("promoteApplyClassesToUtility", () => {
  it("promotes a single-class @apply rule from @layer components to @utility", () => {
    const css = `@layer components {
  .btn-primary {
    @apply px-4 py-2 bg-red-500;
  }
}`;
    const r = promoteApplyClassesToUtility(css);
    expect(r.css).toContain("@utility btn-primary {");
    expect(r.css).not.toContain("@layer components");
    expect(r.notes.some((n) => n.includes("Promoted"))).toBe(true);
  });

  it("keeps compound selectors inside @layer components and flags them", () => {
    const css = `@layer components {
  .card .card-title {
    @apply text-lg font-bold;
  }
}`;
    const r = promoteApplyClassesToUtility(css);
    expect(r.css).toContain("@layer components");
    expect(r.css).toContain(".card .card-title");
    expect(r.notes.some((n) => n.startsWith("MANUAL:"))).toBe(true);
  });

  it("promotes some rules and keeps others in the same @layer block", () => {
    const css = `@layer components {
  .btn-primary {
    @apply px-4 bg-red-500;
  }
  .card .title {
    @apply text-lg;
  }
}`;
    const r = promoteApplyClassesToUtility(css);
    expect(r.css).toContain("@utility btn-primary {");
    expect(r.css).toContain("@layer components");
    expect(r.css).toContain(".card .title");
  });

  it("passes through a comment-only @layer components block instead of dropping it", () => {
    const css = `@layer components {
  /* keep tab styles centralized here for now */
}

.after { color: red; }`;
    const r = promoteApplyClassesToUtility(css);
    expect(r.css).toContain("@layer components");
    expect(r.css).toContain("/* keep tab styles centralized here for now */");
    expect(r.css).toContain(".after { color: red; }");
  });

  it("passes through an empty @layer components block instead of dropping it", () => {
    const css = `@layer components {
}

.after { color: red; }`;
    const r = promoteApplyClassesToUtility(css);
    expect(r.css).toContain("@layer components");
    expect(r.css).toContain(".after { color: red; }");
  });

  it("is a no-op when there is no @layer components block", () => {
    const css = ".foo { color: red; }";
    const r = promoteApplyClassesToUtility(css);
    expect(r.css).toBe(css);
    expect(r.notes).toEqual([]);
  });
});

describe("transformCss", () => {
  it("applies both fixes in sequence", () => {
    const css = `@layer components {
  .btn-brand {
    @apply px-4;
    color: theme(colors.brand.500);
  }
}`;
    const r = transformCss(css);
    expect(r.css).toContain("@utility btn-brand {");
    expect(r.css).toContain("var(--color-brand-500)");
  });
});
