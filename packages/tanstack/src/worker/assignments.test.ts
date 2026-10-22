// @vitest-environment node
/**
 * The assignments part of the edge cache key: what the content assigns a
 * request, never who asked.
 */
import { assign, newVisitor, type Visitor } from "@decocms/blocks/experiments";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAssignments, serializeAssignments } from "../assignments.ts";
import { assignmentsKey, liveAssignmentKeys, readAssignments } from "./assignments.ts";
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
  it("every test on or off for the visitor and every campaign running or not now", async () => {
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
      experiments: { alpha: true, off: false, zeta: true },
      campaigns: { always: true, "black-friday": true, christmas: false },
    });
    expect(assignmentsKey(assignments)).toBe("x=alpha,zeta|c=always,black-friday");
  });

  it("a preview's moment and switched tests and campaigns decide over the visitor and now", async () => {
    const cms = testCMS(
      snapshot({
        experiments: { hero: 50, dark: 0 },
        campaigns: { christmas: { start: "2999-12-20T00:00:00Z" }, sale: {} },
      }),
    );
    const assignments = await readAssignments(cms, {
      visitor: visitorIn("hero", 50, false),
      date: new Date("2999-12-21T00:00:00Z"),
      experiments: { dark: true },
      campaigns: { sale: false },
    });
    expect(assignments).toEqual({
      version: null,
      experiments: { dark: true, hero: false },
      campaigns: { christmas: true, sale: false },
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
      experiments: {},
      campaigns: {},
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
  it("a draft and an old release each key separately", () => {
    const none = { experiments: {}, campaigns: {} };
    const keys = [null, POINTER, SHA].map((version) => assignmentsKey({ version, ...none }));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("");
  });

  it("names on are sorted and encoded; the order they came in doesn't matter", () => {
    const a = assignmentsKey({
      version: null,
      experiments: { b: true, "a|x": true, off: false },
      campaigns: { "c,d": true },
    });
    const b = assignmentsKey({
      version: null,
      experiments: { off: false, "a|x": true, b: true },
      campaigns: { "c,d": true },
    });
    expect(a).toBe(b);
    expect(a).toBe("x=a%7Cx,b|c=c%2Cd");
  });
});

describe("liveAssignmentKeys", () => {
  it("each subset of the tests on, with the running campaigns and with none", async () => {
    const cms = testCMS(
      snapshot({
        experiments: { a: 50, b: 50 },
        campaigns: { sale: {}, later: { start: "2999-01-01" } },
      }),
    );
    expect((await liveAssignmentKeys(cms)).sort()).toEqual(
      ["", "c=sale", "x=a", "x=a|c=sale", "x=b", "x=b|c=sale", "x=a,b", "x=a,b|c=sale"].sort(),
    );
  });
});

describe("the decisions header", () => {
  it("round-trips every name with its state, one spelling per set", () => {
    const d = { experiments: { b: true, "a b": false, "-x": true }, campaigns: { "c|d": false } };
    const value = serializeAssignments(d);
    expect(value).toBe("x=+-x,-a%20b,+b|c=-c%7Cd");
    expect(parseAssignments(value)).toEqual(d);
    expect(serializeAssignments({ experiments: {}, campaigns: {} })).toBe("-");
    expect(parseAssignments("-")).toEqual({ experiments: {}, campaigns: {} });
    for (const bad of [null, "", "x=+b,+a", "x=a", "c=+a|x=+b", "x=+a|x=+b", "v=+a"]) {
      expect(parseAssignments(bad), String(bad)).toBeNull();
    }
  });
});
