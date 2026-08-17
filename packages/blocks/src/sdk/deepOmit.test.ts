import { describe, expect, it } from "vitest";
import { deepOmit } from "./deepOmit";

describe("deepOmit", () => {
  it("removes a top-level key immutably", () => {
    const input = { a: 1, b: 2 };
    const out = deepOmit(input, "b");
    expect(out).toEqual({ a: 1 });
    expect(input).toEqual({ a: 1, b: 2 }); // input untouched
  });

  it("removes a nested dotted path", () => {
    const out = deepOmit({ page: { seo: { title: "x" }, id: 1 } }, "page.seo");
    expect(out).toEqual({ page: { id: 1 } });
  });

  it("fans a wildcard over record values", () => {
    const out = deepOmit(
      { page: { productsMap: { a: { keep: 1, drop: 2 }, b: { keep: 3, drop: 4 } } } },
      "page.productsMap.*.drop",
    );
    expect(out).toEqual({ page: { productsMap: { a: { keep: 1 }, b: { keep: 3 } } } });
  });

  it("fans a wildcard over array elements", () => {
    const out = deepOmit({ items: [{ keep: 1, drop: 2 }, { keep: 3, drop: 4 }] }, "items.*.drop");
    expect(out).toEqual({ items: [{ keep: 1 }, { keep: 3 }] });
  });

  it("auto-applies a path to each array element (no explicit *)", () => {
    const out = deepOmit({ items: [{ a: 1, b: 2 }, { a: 3, b: 4 }] }, "items.b");
    expect(out).toEqual({ items: [{ a: 1 }, { a: 3 }] });
  });

  it("is a no-op for a missing key (never fabricates undefined)", () => {
    const out = deepOmit({ a: 1 }, "b.c.d");
    expect(out).toEqual({ a: 1 });
    expect("b" in out).toBe(false);
  });

  it("applies multiple paths", () => {
    const out = deepOmit({ a: 1, b: 2, c: { d: 3, e: 4 } }, "a", "c.d");
    expect(out).toEqual({ b: 2, c: { e: 4 } });
  });
});
