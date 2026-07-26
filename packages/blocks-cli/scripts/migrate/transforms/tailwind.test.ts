import { describe, expect, it } from "vitest";
import { transformTailwind } from "./tailwind";

describe("transformTailwind — v3 -> v4 class renames", () => {
  it("renames the flex-grow/shrink family", () => {
    const r = transformTailwind(`<div className="flex-grow-0 flex-shrink" />`);
    expect(r.content).toContain('className="grow-0 shrink"');
  });

  it("removes transform/filter (v4 applies them automatically)", () => {
    const r = transformTailwind(`<div className="transform filter scale-105" />`);
    expect(r.content).toContain('className="scale-105"');
  });

  it("bumps the default ring width (v3 3px -> v4 ring-3)", () => {
    const r = transformTailwind(`<div className="ring ring-blue-500" />`);
    expect(r.content).toContain("ring-3 ring-blue-500");
  });

  it("shifts the shadow scale down one step without cascading (single-pass map lookup)", () => {
    const r = transformTailwind(`<div className="shadow-sm" />`);
    expect(r.content).toContain('className="shadow-xs"');
  });

  it("shifts shadow, blur, rounded, and drop-shadow scales independently", () => {
    const r = transformTailwind(
      `<div className="shadow blur rounded drop-shadow" />`,
    );
    expect(r.content).toContain("shadow-sm");
    expect(r.content).toContain("blur-sm");
    expect(r.content).toContain("rounded-sm");
    expect(r.content).toContain("drop-shadow-sm");
  });

  it("renames outline-none to outline-hidden", () => {
    const r = transformTailwind(`<div className="outline-none" />`);
    expect(r.content).toContain('className="outline-hidden"');
  });

  it("renames bg-gradient-to-* to bg-linear-to-*", () => {
    const r = transformTailwind(`<div className="bg-gradient-to-r from-red-500" />`);
    expect(r.content).toContain("bg-linear-to-r");
  });

  it("renames known daisyUI v4 -> v5 classes", () => {
    const r = transformTailwind(`<div className="badge-ghost card-compact" />`);
    expect(r.content).toContain("badge-soft");
    expect(r.content).toContain("card-sm");
  });
});

describe("transformTailwind — gotcha detection (flag, don't auto-fix)", () => {
  it("flags DaisyUI .collapse usage as a manual-review finding", () => {
    const r = transformTailwind(
      `<div className="collapse"><div className="collapse-title" /></div>`,
    );
    expect(r.notes.some((n) => n.startsWith("MANUAL:") && n.includes("collapse"))).toBe(true);
  });

  it("flags btn-group and form-control as removed-in-v5", () => {
    const r = transformTailwind(`<div className="btn-group" /><div className="form-control" />`);
    expect(r.notes.filter((n) => n.startsWith("MANUAL:")).length).toBeGreaterThanOrEqual(2);
  });

  it("flags a shorthand/longhand spacing conflict (px-* mixed with pl-*/pr-*)", () => {
    const r = transformTailwind(`<div className="pl-4 sm:pl-0 md:px-6" />`);
    expect(r.notes.some((n) => n.startsWith("MANUAL:") && n.includes("padding-inline"))).toBe(true);
  });

  it("does not flag px-* used alone (no mixed longhand)", () => {
    const r = transformTailwind(`<div className="px-4 md:px-6" />`);
    expect(r.notes.some((n) => n.includes("padding-inline"))).toBe(false);
  });
});
