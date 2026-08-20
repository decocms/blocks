import { describe, expect, it } from "vitest";
import { transformJsx } from "./jsx";

describe("transformJsx — class in type annotations", () => {
  it("renames an INLINE `class?:` type property (mid-line)", () => {
    const src = `function P({ height, className: _c }: { height: string; class?: string }) {}`;
    const out = transformJsx(src).content;
    expect(out).toContain("className?: string");
    expect(out).not.toContain("class?: string");
    // the destructuring rename is preserved
    expect(out).toContain("className: _c");
  });

  it("still renames a line-start `class?:` in an interface", () => {
    const out = transformJsx(`interface Props {\n  class?: string;\n}`).content;
    expect(out).toContain("className?: string");
  });

  it("renames `class?:` inside a union member", () => {
    const out = transformJsx(`type T = { a: 1 } | { class?: number };`).content;
    expect(out).toContain("className?: number");
  });

  it("does NOT touch a runtime `class:` value (no `?`)", () => {
    const out = transformJsx(`const x = { class: "btn" };`).content;
    expect(out).toContain(`class: "btn"`);
  });
});
