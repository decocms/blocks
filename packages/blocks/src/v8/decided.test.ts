// @vitest-environment node
/**
 * `cms.client({ decided })`: a client that answers the saved `experiments`
 * and `campaigns` from decisions made earlier for the request (a cache key
 * in a URL), not from the visitor and the moment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { newVisitor } from "./experiments";
import type { Blocks, Snapshot } from "./types";

beforeEach(() => resetForTests());
afterEach(() => vi.useRealTimers());

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
const pick = (rule: unknown, on: string, off: string) => ({
  __resolveType: "multivariate",
  variants: [
    { rule, value: lazy({ __resolveType: "title", text: on }) },
    { rule: { __resolveType: "always" }, value: lazy({ __resolveType: "title", text: off }) },
  ],
});

const blocks: Blocks = { title: ({ text }: { text: string }) => text };
const content: Snapshot = {
  revision: "r1",
  blocks: {
    experiments: { __resolveType: "split-traffic", everyone: 100, nobody: 0, half: 50 },
    campaigns: {
      __resolveType: "date-windows",
      past: { start: "2000-01-01T00:00:00Z", end: "2001-01-01T00:00:00Z" },
      now: { start: "2000-01-01T00:00:00Z" },
    },
    Half: pick({ __resolveType: "experiment", name: "half" }, "B", "A"),
    Past: pick({ __resolveType: "date", campaign: "past" }, "sale", "regular"),
  },
};

describe("cms.client({ decided })", () => {
  it("answers experiments with the decided tests only, whatever the visitor", async () => {
    const cms = createCMS({ blocks, content });
    const decided = { experiments: ["half", "nobody", "gone"], campaigns: [] };
    for (let i = 0; i < 10; i++) {
      const client = cms.client({ visitor: newVisitor(), decided });
      expect({ ...(await client.resolve("experiments"))[0]! }).toEqual({
        everyone: false,
        half: true,
        nobody: true,
      });
      expect((await client.resolve("Half"))[0]).toBe("B");
    }
    const none = cms.client({ visitor: newVisitor(), decided: { experiments: [], campaigns: [] } });
    expect((await none.resolve("Half"))[0]).toBe("A");
  });

  it("answers campaigns with the decided campaigns only, whatever the moment", async () => {
    const cms = createCMS({ blocks, content });
    const client = cms.client({ decided: { experiments: [], campaigns: ["past"] } });
    expect({ ...(await client.resolve("campaigns"))[0]! }).toEqual({ past: true, now: false });
    expect((await client.resolve("Past"))[0]).toBe("sale");
    expect((await cms.client().resolve("Past"))[0]).toBe("regular");
  });

  it("keeps deciding when no decisions are given, and copies the ones given", async () => {
    const cms = createCMS({ blocks, content });
    expect({ ...(await cms.client({ decided: null }).resolve("campaigns"))[0]! }).toEqual({
      past: false,
      now: true,
    });
    const decided = { experiments: ["half"], campaigns: [] as string[] };
    const client = cms.client({ decided });
    decided.experiments.length = 0;
    expect((await client.resolve("Half"))[0]).toBe("B");
  });
});
