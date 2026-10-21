// @vitest-environment node
/**
 * The assignments part of the edge cache key: what the content assigns a
 * request, never who asked.
 */
import { assign, newVisitor, type Visitor } from "@decocms/blocks/experiments";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentsKey, readAssignments } from "./assignments.ts";
import { POINTER, snapshot, testCMS } from "./testing.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => {
  vi.useRealTimers();
});

function visitorIn(test: string, share: number, inside: boolean): Visitor {
  for (;;) {
    const v = newVisitor();
    if (assign({ [test]: share }, v)[test] === inside) return v;
  }
}

describe("readAssignments", () => {
  it("the tests the visitor is in and the campaigns running now, sorted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-28T12:00:00Z"));
    const cms = testCMS(
      snapshot({
        experiments: { zeta: 100, alpha: 100, off: 0 },
        campaigns: {
          "black-friday": { start: "2026-11-27T00:00:00Z", end: "2026-12-01T00:00:00Z" },
          christmas: { start: "2026-12-20T00:00:00Z", end: "2026-12-26T00:00:00Z" },
          always: {},
        },
      }),
    );
    const assignments = await readAssignments(cms, { visitor: newVisitor(), version: null });
    expect(assignments).toEqual({
      version: null,
      experiments: ["alpha", "zeta"],
      campaigns: ["always", "black-friday"],
    });
  });

  it("missing blocks: no assignments, no error", async () => {
    const assignments = await readAssignments(testCMS(), { visitor: newVisitor(), version: null });
    expect(assignmentsKey(assignments)).toBe("");
  });

  it("content that doesn't load: no assignments, no error", async () => {
    const broken = {
      client: () => ({
        list: async () => [null, new Error("down")],
        resolve: async () => [null, new Error("down")],
      }),
    } as unknown as Parameters<typeof readAssignments>[0];
    expect(await readAssignments(broken, { visitor: null, version: null })).toEqual({
      version: null,
      experiments: [],
      campaigns: [],
    });
  });

  it("opposite sides of a 50% test decide differently; the same side alike", async () => {
    const cms = testCMS(snapshot({ experiments: { hero: 50 } }));
    const key = async (visitor: Visitor) =>
      assignmentsKey(await readAssignments(cms, { visitor, version: null }));
    const a = await key(visitorIn("hero", 50, true));
    const b = await key(visitorIn("hero", 50, true));
    const c = await key(visitorIn("hero", 50, false));
    expect(a).toBe("x=hero");
    expect(b).toBe(a);
    expect(c).toBe("");
  });
});

describe("assignmentsKey", () => {
  it("a draft, an old release and a preview time each key separately", () => {
    const none = { experiments: [], campaigns: [] };
    const keys = [
      null,
      POINTER,
      SHA,
      `${SHA}?__at=${encodeURIComponent("2026-11-28T10:00:00-03:00")}`,
      `${POINTER.replace("@", "&__at=2026-11-28T10%3A00%3A00Z@")}`,
    ].map((version) => assignmentsKey({ version, ...none }));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("");
  });

  it("names are sorted and encoded; the order they came in doesn't matter", () => {
    const a = assignmentsKey({ version: null, experiments: ["b", "a|x"], campaigns: ["c,d"] });
    const b = assignmentsKey({ version: null, experiments: ["a|x", "b"], campaigns: ["c,d"] });
    expect(a).toBe(b);
    expect(a).toBe("x=a%7Cx,b|c=c%2Cd");
  });
});
