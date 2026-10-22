// @vitest-environment node
/**
 * A/B tests as content (built-in-blocks#split-traffic,
 * matchers-and-variants#experiment, api-reference#experiments): the saved
 * block `experiments` of the built-in type `split-traffic`, the built-in
 * `experiment` rule, and the visitor a client is created with. One test per
 * claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "../cms";
import { currentClient } from "../current";
import { newVisitor, type Visitor } from "../experiments";
import { docsBlocks, docsSnapshot, fakeStudio } from "../testFixtures";
import type { Blocks, Client, Snapshot } from "../types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

/** `hero-copy` rolls 0.93 and 97.85, `pdp-cta` 42.5 and 84.57 (pinned in experiments.test.ts). */
const LOW: Visitor = { id: "Zm9vYmFyYmF6cXV4MTIzNA", active: [], inactiveDrawn: [], pct: {} };
const HIGH: Visitor = { id: "AAAAAAAAAAAAAAAAAAAAAA", active: [], inactiveDrawn: [], pct: {} };

/** A variant that shows "New" for the visitors in `name`, "Old" for the rest. */
const abTest = (name: string) => ({
  __resolveType: "multivariate",
  variants: [
    {
      rule: { __resolveType: "experiment", name },
      value: lazy({ __resolveType: "hero", title: "New" }),
    },
    { rule: { __resolveType: "always" }, value: lazy({ __resolveType: "hero", title: "Old" }) },
  ],
});

/** The docs' content plus a saved `experiments` block and a section that varies on `buy-button`. */
function snapshotWith(experiments: Record<string, unknown> | undefined): Snapshot {
  const base = docsSnapshot();
  const blocks: Snapshot["blocks"] = { ...base.blocks, BuyButton: abTest("buy-button") };
  if (experiments !== undefined) {
    blocks.experiments = { __resolveType: "split-traffic", ...experiments };
  }
  return { ...base, blocks };
}

const title = async (client: Client) => {
  const [value] = await client.resolve("BuyButton");
  return (value as { props?: { title?: string } } | undefined)?.props?.title;
};

describe("the saved block experiments", () => {
  it("exp-01: resolving it gives each test and whether the client's visitor is in it, never a percentage", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "hero-copy": 50, "pdp-cta": 50 }),
    });
    const [low] = await cms.client({ visitor: LOW }).resolve("experiments");
    expect({ ...(low as object) }).toEqual({ "hero-copy": true, "pdp-cta": true });
    const [high] = await cms.client({ visitor: HIGH }).resolve("experiments");
    expect({ ...(high as object) }).toEqual({ "hero-copy": false, "pdp-cta": false });
  });

  it("exp-02: 0 puts nobody in, 100 everybody", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ off: 0, all: 100 }) });
    for (let i = 0; i < 100; i++) {
      const [tests] = await cms.client({ visitor: newVisitor() }).resolve("experiments");
      expect({ ...(tests as object) }).toEqual({ off: false, all: true });
    }
  });

  it("exp-03: a client made without a visitor has every test off, and never throws", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ all: 100 }) });
    for (const client of [cms.client(), cms.client({ visitor: null }), cms.forRelease()]) {
      const [tests, error] = await client.resolve("experiments");
      expect(error).toBeNull();
      expect({ ...(tests as object) }).toEqual({ all: false });
      expect(await title(client)).toBe("Old");
    }
  });

  it("exp-04: split-traffic and experiment are reserved names; experiments stays free", async () => {
    const { RESERVED_NAMES } = await import("../builtins/index");
    expect(RESERVED_NAMES.has("split-traffic")).toBe(true);
    expect(RESERVED_NAMES.has("experiment")).toBe(true);
    expect(RESERVED_NAMES.has("experiments")).toBe(false);
  });

  it("exp-05: a component's prop filled with the experiments block gets the true/false map", async () => {
    const hero = vi.fn((props: { experiments: Record<string, boolean> }) => props);
    const content = snapshotWith({ "hero-copy": 50 });
    content.blocks.Hero = {
      __resolveType: "my-hero",
      experiments: { __resolveType: "experiments" },
    };
    const cms = createCMS({ blocks: { ...docsBlocks(), "my-hero": hero }, content });
    await cms.client({ visitor: LOW }).resolve("Hero");
    expect({ ...hero.mock.calls[0][0].experiments }).toEqual({ "hero-copy": true });
  });
});

describe("the experiment rule", () => {
  it("exp-06: true when the client's visitor is in the named test, so the variant shows", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "buy-button": 100 }) });
    expect(await title(cms.client({ visitor: newVisitor() }))).toBe("New");
    resetForTests();
    const off = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "buy-button": 0 }) });
    expect(await title(off.client({ visitor: newVisitor() }))).toBe("Old");
  });

  it("exp-07: false for a name the experiments block doesn't have, and with no experiments block", async () => {
    const other = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "hero-copy": 100 }) });
    expect(await title(other.client({ visitor: newVisitor() }))).toBe("Old");
    resetForTests();
    const none = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    const [, error] = await none.client({ visitor: newVisitor() }).resolve("BuyButton");
    expect(error).toBeNull();
    expect(await title(none.client({ visitor: newVisitor() }))).toBe("Old");
  });

  it("exp-08: tests are decided once per client, however many rules ask", async () => {
    const split = vi.fn((allocations: Record<string, number>) =>
      Object.fromEntries(Object.keys(allocations).map((name) => [name, true])),
    );
    const content = snapshotWith({ "buy-button": 50 });
    content.blocks.Page = {
      __resolveType: "page",
      name: "p",
      path: "/p",
      sections: [abTest("buy-button"), abTest("buy-button"), { __resolveType: "BuyButton" }],
    };
    const cms = createCMS({ blocks: { ...docsBlocks(), "split-traffic": split }, content });
    const client = cms.client({ visitor: newVisitor() });
    await client.resolve("Page");
    await client.resolve("BuyButton");
    expect(split).toHaveBeenCalledTimes(1);
    await cms.client({ visitor: newVisitor() }).resolve("Page");
    expect(split).toHaveBeenCalledTimes(2); // a new client decides again
  });

  it("exp-09: a block map's own experiment replaces the built-in, as for every built-in", async () => {
    const cms = createCMS({
      blocks: { ...docsBlocks(), experiment: () => true },
      content: snapshotWith({ "buy-button": 0 }),
    });
    expect(await title(cms.client())).toBe("New");
  });

  it("exp-10: a site's own block reads the tests through currentClient()", async () => {
    const blocks: Blocks = {
      ...docsBlocks(),
      "button-label": ({ label }: { label: string }) =>
        currentClient()
          .resolve<Record<string, boolean>>("experiments")
          .then(([tests]) => (tests?.["buy-button"] ? `${label}!` : label)),
    };
    const content = snapshotWith({ "buy-button": 100 });
    content.blocks.Label = { __resolveType: "button-label", label: "Buy" };
    const cms = createCMS({ blocks, content });
    expect((await cms.client({ visitor: newVisitor() }).resolve("Label"))[0]).toBe("Buy!");
    expect((await cms.client().resolve("Label"))[0]).toBe("Buy");
  });
});

describe("visitors and versions", () => {
  it("exp-11: the same visitor id gets the same groups from any client", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ a: 50, b: 50, c: 50 }) });
    for (let i = 0; i < 20; i++) {
      const visitor = newVisitor();
      const [first] = await cms.client({ visitor }).resolve("experiments");
      const [again] = await cms.client({ visitor: { ...visitor } }).resolve("experiments");
      expect({ ...(again as object) }).toEqual({ ...(first as object) });
    }
  });

  it("exp-12: each client keeps its own copy of the visitor; concurrent clients never mix", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "hero-copy": 50 }) });
    const mine = { ...LOW, active: [] as string[] };
    const low = cms.client({ visitor: mine });
    const high = cms.client({ visitor: HIGH });
    mine.id = HIGH.id; // the caller's object changing later changes no client
    expect(low.visitor?.id).toBe(LOW.id);
    const [a, b] = await Promise.all([low.resolve("experiments"), high.resolve("experiments")]);
    expect((a[0] as Record<string, boolean>)["hero-copy"]).toBe(true);
    expect((b[0] as Record<string, boolean>)["hero-copy"]).toBe(false);
  });

  it("exp-13: a draft's experiments: a test only in the draft is on in its preview and off on the release", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    const pointer = studio.draft({
      set: { experiments: { __resolveType: "split-traffic", "buy-button": 100 } },
    });
    const visitor = newVisitor();
    expect(await title(cms.client({ visitor, version: pointer }))).toBe("New");
    expect(await title(cms.client({ visitor }))).toBe("Old");
  });
});
