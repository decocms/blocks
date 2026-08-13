import { describe, expect, it } from "vitest";
import { renameToken } from "./tailwind-renames";

describe("renameToken", () => {
  it("renames a bare utility with no modifier prefix", () => {
    expect(renameToken("flex-grow")).toBe("grow");
    expect(renameToken("ring")).toBe("ring-3");
  });

  it("preserves a single modifier prefix when renaming", () => {
    expect(renameToken("md:flex-grow")).toBe("md:grow");
    expect(renameToken("hover:ring")).toBe("hover:ring-3");
  });

  it("preserves a stacked modifier chain when renaming", () => {
    expect(renameToken("dark:hover:ring")).toBe("dark:hover:ring-3");
  });

  it("renames a DaisyUI class behind a modifier prefix", () => {
    expect(renameToken("hover:badge-ghost")).toBe("hover:badge-soft");
  });

  it("removes a class (and its modifier prefix) entirely when v4 drops it (e.g. transform is now automatic)", () => {
    expect(renameToken("transform")).toBe("");
    expect(renameToken("md:transform")).toBe("");
  });

  it("is a true no-op for an identity rename, even with a modifier prefix", () => {
    expect(renameToken("transform-none")).toBe("transform-none");
    expect(renameToken("md:transform-none")).toBe("md:transform-none");
  });

  it("leaves an unknown class unchanged", () => {
    expect(renameToken("bg-red-500")).toBe("bg-red-500");
    expect(renameToken("md:bg-red-500")).toBe("md:bg-red-500");
  });
});

import { detectDaisyUiV5StructuralIssues } from "./tailwind-renames";

describe("detectDaisyUiV5StructuralIssues", () => {
  it("detects menu-compact removal", () => {
    const findings = detectDaisyUiV5StructuralIssues(`<ul className="menu menu-compact">`);
    expect(findings.some((f) => f.message.includes("menu-compact"))).toBe(true);
  });

  it("detects tab-bordered removal", () => {
    const findings = detectDaisyUiV5StructuralIssues(`<a className="tab tab-bordered">`);
    expect(findings.some((f) => f.message.includes("tab-bordered"))).toBe(true);
  });

  it("detects bare alert in className without a color modifier", () => {
    const findings = detectDaisyUiV5StructuralIssues(`<div className="alert">`);
    expect(findings.some((f) => f.message.includes("alert"))).toBe(true);
  });

  it("does not flag alert when a color modifier is present", () => {
    const findings = detectDaisyUiV5StructuralIssues(`<div className="alert alert-info">`);
    expect(findings.some((f) => f.message.includes("alert default styling"))).toBe(false);
  });

  it("does not flag alert() JS function calls as a DaisyUI alert", () => {
    const findings = detectDaisyUiV5StructuralIssues(`window.alert("something went wrong");`);
    expect(findings.some((f) => f.message.includes("alert default styling"))).toBe(false);
  });
});
