import { describe, expect, it } from "vitest";
import { mergeSections } from "./mergeSections";
import type { DeferredSection, ResolvedSection } from "./resolve";

const eager = (component: string, index?: number): ResolvedSection => ({
  component,
  props: {},
  key: `k-${component}`,
  ...(index === undefined ? {} : { index }),
});

const deferred = (component: string, index: number): DeferredSection => ({
  component,
  key: `k-${component}`,
  index,
  propsHash: "h",
});

/** The rendered order, as component names — what a reader actually cares about. */
const order = (items: ReturnType<typeof mergeSections>) =>
  items.map((i) => (i.type === "eager" ? i.section.component : i.deferred.component));

describe("mergeSections", () => {
  it("interleaves deferred sections back into their authored position", () => {
    // The real shape from a storefront home: a deferred shelf authored between
    // a banner and the newsletter. Rendering the two arrays separately would
    // push the shelf to the bottom.
    const items = mergeSections(
      [eager("Carousel", 0), eager("Banner", 1), eager("Newsletter", 3)],
      [deferred("ShelfTabbed", 2)],
    );
    expect(order(items)).toEqual(["Carousel", "Banner", "ShelfTabbed", "Newsletter"]);
  });

  it("keeps input order when nothing is deferred", () => {
    const items = mergeSections([eager("A"), eager("B"), eager("C")], []);
    expect(order(items)).toEqual(["A", "B", "C"]);
    expect(items.every((i) => i.type === "eager")).toBe(true);
  });

  it("stamps originalIndex by array position, not by the CMS index", () => {
    const items = mergeSections([eager("A", 5), eager("B", 9)], [deferred("D", 7)]);
    const eagers = items.filter((i) => i.type === "eager") as Extract<
      (typeof items)[number],
      { type: "eager" }
    >[];
    expect(eagers.map((i) => i.originalIndex)).toEqual([0, 1]);
  });

  it("falls back to array position when an eager section carries no index", () => {
    // Pre-deferral behavior: sections resolved without an `index` stamp still
    // render in the order they arrived. Here B (position 1) ties with D
    // (index 1); the sort is stable, so eager stays ahead of deferred. Pinning
    // the tie so a future refactor to an unstable sort is caught.
    const items = mergeSections([eager("A"), eager("B")], [deferred("D", 1)]);
    expect(order(items)).toEqual(["A", "B", "D"]);
  });

  it("handles a page that is entirely deferred", () => {
    // The real PDP shape: every section wrapped in Rendering/Lazy.
    const items = mergeSections(
      [],
      [deferred("Details", 0), deferred("Shelf", 1), deferred("Newsletter", 2)],
    );
    expect(order(items)).toEqual(["Details", "Shelf", "Newsletter"]);
    expect(items.every((i) => i.type === "deferred")).toBe(true);
  });

  it("sorts deferred sections that arrive out of order", () => {
    const items = mergeSections([eager("A", 0)], [deferred("Z", 3), deferred("M", 1)]);
    expect(order(items)).toEqual(["A", "M", "Z"]);
  });

  it("returns empty for an empty page", () => {
    expect(mergeSections([], [])).toEqual([]);
  });

  it("tolerates null/undefined arrays", () => {
    expect(mergeSections(null as never, undefined as never)).toEqual([]);
    expect(order(mergeSections([eager("A")], null as never))).toEqual(["A"]);
  });

  it("does not mutate its inputs", () => {
    const resolved = [eager("B", 1), eager("A", 0)];
    const def = [deferred("D", 2)];
    const snapshot = JSON.stringify({ resolved, def });
    mergeSections(resolved, def);
    expect(JSON.stringify({ resolved, def })).toBe(snapshot);
  });

  it("does not leak the internal _sort key into the result", () => {
    // The sort key is an implementation detail; a binding that iterated
    // Object.keys on a PageItem would otherwise see it.
    const items = mergeSections([eager("A", 0)], [deferred("D", 1)]);
    for (const item of items) {
      expect(Object.keys(item)).not.toContain("_sort");
    }
  });
});
