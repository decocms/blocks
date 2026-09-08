import { describe, expect, it } from "vitest";
import { bgOf, cx, fgOf, parseVariants } from "./variants";

describe("parseVariants", () => {
  it("reads colour, size and modifiers off a class string", () => {
    const v = parseVariants("btn btn-primary btn-sm btn-outline", "btn");
    expect(v).toMatchObject({ color: "primary", size: "sm", outline: true });
  });

  it("defaults to md with no colour", () => {
    const v = parseVariants("btn", "btn");
    expect(v.size).toBe("md");
    expect(v.color).toBeUndefined();
  });

  it("keeps unrecognised classes instead of eating them", () => {
    // `className="btn btn-primary mt-4"` must not silently lose `mt-4` — a
    // dropped layout class looks like a broken component with no clue why.
    expect(parseVariants("btn btn-primary mt-4 w-full", "btn").rest).toEqual(["mt-4", "w-full"]);
  });

  it("keeps a modifier it does not model yet", () => {
    // `btn-active` has no variant field. Passing it through means a later
    // version can pick it up without any caller changing.
    expect(parseVariants("btn btn-active", "btn").rest).toEqual(["btn-active"]);
  });

  it("does not confuse another family's prefix", () => {
    // A badge inside a button: `badge-primary` must not set the BUTTON colour.
    const v = parseVariants("btn badge-primary", "btn");
    expect(v.color).toBeUndefined();
    expect(v.rest).toEqual(["badge-primary"]);
  });

  it("takes the last colour when several are present", () => {
    expect(parseVariants("btn btn-primary btn-error", "btn").color).toBe("error");
  });

  it("survives an empty or missing className", () => {
    expect(parseVariants(undefined, "btn").size).toBe("md");
    expect(parseVariants("   ", "btn").rest).toEqual([]);
  });
});

describe("utility mapping", () => {
  it("maps a semantic colour to the site's own theme utility", () => {
    // `bg-primary` resolves through the site's `@theme`, so it is the same
    // value the web uses — that is the whole point of not hardcoding hexes.
    expect(bgOf("primary")).toBe("bg-primary");
    expect(fgOf("primary")).toBe("text-white");
  });

  it("falls back to neutral greys with no colour", () => {
    expect(bgOf(undefined)).toBe("bg-gray-200");
    expect(fgOf(undefined)).toBe("text-gray-900");
  });

  it("never emits a DaisyUI class name", () => {
    // The regression this guards: forwarding `btn`/`badge` to className crashes
    // the RN style runtime (undefined `var(--border)` → `.length` throw), so
    // this layer must translate, never pass through.
    const emitted = [bgOf("primary"), fgOf("primary"), bgOf(undefined)];
    for (const cls of emitted) {
      expect(cls).not.toMatch(/^(btn|badge|card|modal|drawer|input|loading|tabs|collapse|join)\b/);
    }
  });
});

describe("cx", () => {
  it("skips falsy so callers can inline conditionals", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
  });
});

describe("packaged CSS entry", () => {
  it("declares its own sources relative to itself", async () => {
    // The app cannot do this with `@source "…/node_modules/@decocms/native/src"`:
    // in a linked checkout that is a symlink, and Tailwind does not walk
    // symlinked directories. Classes used ONLY here then vanish from the CSS —
    // a transparent modal, an uncoloured button, no error anywhere.
    const fs = await import("node:fs");
    const css = fs.readFileSync("packages/native/src/daisy/daisy.css", "utf8");
    expect(css).toContain('@source "./**/*.{ts,tsx}"');
  });
});
