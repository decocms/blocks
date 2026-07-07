import { describe, expect, it } from "vitest";
import {
  LIB_TEMPLATES,
  selectImportedLibTemplates,
} from "./lib-utils";

describe("LIB_TEMPLATES registry", () => {
  it("has entries", () => {
    expect(Object.keys(LIB_TEMPLATES).length).toBeGreaterThan(0);
  });

  it("uses src/lib/<name>.ts keys (relative paths the writer expects)", () => {
    for (const key of Object.keys(LIB_TEMPLATES)) {
      expect(key).toMatch(/^src\/lib\/[a-z][a-z0-9-]*\.ts$/);
    }
  });

  it("has non-empty contents for every entry", () => {
    for (const [key, value] of Object.entries(LIB_TEMPLATES)) {
      expect(value, `${key} should have content`).toBeTruthy();
      expect(value.length, `${key} length`).toBeGreaterThan(20);
    }
  });

  it("has unique keys (no shadowing)", () => {
    const keys = Object.keys(LIB_TEMPLATES);
    const set = new Set(keys);
    expect(set.size).toBe(keys.length);
  });
});

describe("selectImportedLibTemplates()", () => {
  it("returns empty record when no specifiers are imported", () => {
    expect(selectImportedLibTemplates(new Set())).toEqual({});
  });

  it("returns only the templates whose specifier is in the set", () => {
    const result = selectImportedLibTemplates(new Set(["vtex-segment"]));
    expect(Object.keys(result)).toEqual(["src/lib/vtex-segment.ts"]);
    expect(result["src/lib/vtex-segment.ts"]).toBe(LIB_TEMPLATES["src/lib/vtex-segment.ts"]);
  });

  it("returns multiple templates when multiple specifiers are imported", () => {
    const result = selectImportedLibTemplates(
      new Set(["vtex-segment", "vtex-transform", "filter-navigate"]),
    );
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "src/lib/filter-navigate.ts",
      "src/lib/vtex-segment.ts",
      "src/lib/vtex-transform.ts",
    ]);
  });

  it("ignores unknown specifiers without throwing", () => {
    const result = selectImportedLibTemplates(
      new Set(["vtex-segment", "this-template-does-not-exist"]),
    );
    expect(Object.keys(result)).toEqual(["src/lib/vtex-segment.ts"]);
  });

  it("does not mutate LIB_TEMPLATES (returns a fresh object)", () => {
    const before = JSON.stringify(LIB_TEMPLATES);
    const result = selectImportedLibTemplates(new Set(["vtex-segment"]));
    result["src/lib/vtex-segment.ts"] = "// HIJACKED";
    expect(JSON.stringify(LIB_TEMPLATES)).toBe(before);
  });

  it("covers every well-known migration target the writer might emit", () => {
    // Sanity check: the names that `transforms/imports.ts` rewrites to
    // and that phase-cleanup hoists for inline-stub injection MUST all
    // have templates registered, otherwise migrated sites get import
    // errors with no warning.
    const expectedSpecifiers = [
      "vtex-transform",
      "vtex-intelligent-search",
      "vtex-segment",
      "vtex-fetch",
      "vtex-id",
      "vtex-client",
      "fetch-utils",
      "http-utils",
      "graphql-utils",
      "filter-navigate",
    ];
    for (const spec of expectedSpecifiers) {
      const key = `src/lib/${spec}.ts`;
      expect(LIB_TEMPLATES, `expected template for ${key}`).toHaveProperty(key);
    }
  });
});

describe("D3 — generated stubs throw at runtime", () => {
  // Each stub MUST throw an Error whose message identifies:
  //  - the stub path so the dev sees it in their stack trace
  //  - the canonical replacement (so the fix is mechanical)
  //
  // See migration-tooling-policy.mdc § Decision 3.
  it("vtex-transform.toProduct throws and points at the canonical path", () => {
    const src = LIB_TEMPLATES["src/lib/vtex-transform.ts"];
    expect(src).toMatch(/throw new Error/);
    expect(src).toMatch(/@decocms\/apps\/vtex\/utils\/transform/);
    expect(src).toMatch(/\[deco-migrate\]/);
  });

  it("vtex-intelligent-search.getISCookiesFromBag throws", () => {
    const src = LIB_TEMPLATES["src/lib/vtex-intelligent-search.ts"];
    expect(src).toMatch(/getISCookiesFromBag[\s\S]*?throw new Error/);
    expect(src).toMatch(/\[deco-migrate\]/);
    // The other helpers in this file (isFilterParam, toPath,
    // withDefaultFacets, withDefaultParams) are real impls — must not
    // throw.
    expect(src).toMatch(/export function isFilterParam[\s\S]*?return key\.startsWith/);
  });

  it("vtex-segment.getSegmentFromBag and withSegmentCookie both throw", () => {
    const src = LIB_TEMPLATES["src/lib/vtex-segment.ts"];
    expect(src).toMatch(/getSegmentFromBag[\s\S]*?throw new Error/);
    expect(src).toMatch(/withSegmentCookie[\s\S]*?throw new Error/);
    expect(src).toMatch(/@decocms\/apps\/vtex\/utils\/segment/);
  });

  it("non-stub helpers stay implemented (negative check — no throw)", () => {
    // These are real impls, not stubs. They must not throw.
    const real = [
      "src/lib/http-utils.ts",
      "src/lib/vtex-id.ts",
      "src/lib/graphql-utils.ts",
      "src/lib/filter-navigate.ts",
      "src/lib/fetch-utils.ts",
    ];
    for (const key of real) {
      const src = LIB_TEMPLATES[key];
      expect(src, `${key} should not contain a generated stub throw`).not.toMatch(
        /\[deco-migrate\][^"]*generated stub/,
      );
    }
  });
});
