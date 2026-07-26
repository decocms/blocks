import { describe, expect, it } from "vitest";
import { fixOklchHexMismatches, hexToOklchTriplet, isOklchCoordinates } from "./color-oklch";

describe("isOklchCoordinates", () => {
  it("matches bare oklch triplets", () => {
    expect(isOklchCoordinates("0.55 0.2 30")).toBe(true);
    expect(isOklchCoordinates("0.85 0.15 120 / 0.5")).toBe(true);
  });

  it("rejects hex and other color syntaxes", () => {
    expect(isOklchCoordinates("#B10200")).toBe(false);
    expect(isOklchCoordinates("rgb(1, 2, 3)")).toBe(false);
  });
});

describe("hexToOklchTriplet", () => {
  it("converts white to L=1 C=0", () => {
    const triplet = hexToOklchTriplet("#ffffff");
    expect(triplet).not.toBeNull();
    const [l, c] = triplet!.split(" ").map(Number);
    expect(l).toBeCloseTo(1, 2);
    expect(c).toBeCloseTo(0, 2);
  });

  it("converts black to L=0 C=0", () => {
    const triplet = hexToOklchTriplet("#000000");
    expect(triplet).not.toBeNull();
    const [l, c] = triplet!.split(" ").map(Number);
    expect(l).toBeCloseTo(0, 2);
    expect(c).toBeCloseTo(0, 2);
  });

  it("expands 3-digit hex", () => {
    expect(hexToOklchTriplet("#fff")).toBe(hexToOklchTriplet("#ffffff"));
  });

  it("returns null for unparseable input", () => {
    expect(hexToOklchTriplet("not-a-color")).toBeNull();
  });
});

describe("fixOklchHexMismatches", () => {
  it("converts a hex-declared var used as oklch(var(--x)) into an oklch triplet", () => {
    const css = `:root {
  --icon-color: #B10200;
}
.icon {
  fill: oklch(var(--icon-color));
}`;

    const result = fixOklchHexMismatches(css);
    expect(result.fixed.length).toBe(1);
    expect(result.css).toMatch(/--icon-color:\s*[\d.]+\s+[\d.]+\s+[\d.]+;/);
    expect(result.css).not.toContain("#B10200");
  });

  it("leaves already-valid oklch coordinate declarations untouched", () => {
    const css = `:root {
  --icon-color: 0.55 0.2 30;
}
.icon {
  fill: oklch(var(--icon-color));
}`;

    const result = fixOklchHexMismatches(css);
    expect(result.fixed).toEqual([]);
    expect(result.flagged).toEqual([]);
    expect(result.css).toBe(css);
  });

  it("flags rgb()-declared vars used as oklch(var(--x)) instead of guessing", () => {
    const css = `:root {
  --icon-color: rgb(10, 20, 30);
}
.icon {
  fill: oklch(var(--icon-color));
}`;

    const result = fixOklchHexMismatches(css);
    expect(result.fixed).toEqual([]);
    expect(result.flagged.length).toBe(1);
  });
});
