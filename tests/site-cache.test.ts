// @vitest-environment node
/**
 * The page cache is the site's on both bindings, built from the same pieces:
 * `readAssignments` and `assignmentsKey` give the same answers from
 * `@decocms/tanstack/worker` and `@decocms/nextjs/proxy` (each binding keeps
 * its own copy: they never import each other), so a site's key reads the
 * same on either.
 */
import { createCMS, type Snapshot } from "@decocms/blocks";
import { assign, newVisitor, type Visitor } from "@decocms/blocks/experiments";
import * as next from "@decocms/nextjs/proxy";
import * as tanstack from "@decocms/tanstack/worker";
import { describe, expect, it } from "vitest";

describe("readAssignments and assignmentsKey, on both bindings", () => {
  const cms = createCMS({
    blocks: {},
    content: {
      revision: "r1",
      root: "/site-cache-parity",
      blocks: {
        experiments: { __resolveType: "split-traffic", hero: 50, "new buy": 50, all: 100, off: 0 },
        campaigns: {
          __resolveType: "calendar",
          always: {},
          past: { start: "2001-01-01T00:00:00Z", end: "2001-01-02T00:00:00Z" },
        },
      },
    } as Snapshot & { root: string },
  });
  const visitors: (Visitor | null)[] = [null];
  while (visitors.length < 9) {
    const v = newVisitor();
    const sides = assign({ hero: 50, "new buy": 50 }, v);
    if (visitors.length % 4 === Number(sides.hero) * 2 + Number(sides["new buy"])) visitors.push(v);
  }

  it("the same assignments and key for every visitor and version", async () => {
    for (const visitor of visitors) {
      for (const version of [null, "0123456789abcdef0123456789abcdef01234567"]) {
        const a = await tanstack.readAssignments(cms, { visitor, version });
        const b = await next.readAssignments(cms, { visitor, version });
        expect(a).toEqual(b);
        expect(tanstack.assignmentsKey(a)).toBe(next.assignmentsKey(b));
      }
    }
  });
});
