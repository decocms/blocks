// @vitest-environment node
/**
 * A/B tests as content (built-in-blocks#experiments, matchers-and-variants#experiment,
 * api-reference#cms-experiments): the built-in type `experiments`, saved as the
 * well-known block `Experiments`, the built-in `experiment` matcher, and the
 * assignments a client is created with. One test per claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "../cms";
import { assign } from "../experiments";
import { docsBlocks, docsSnapshot, fakeStudio } from "../testFixtures";
import type { Snapshot } from "../types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

/** The docs' content plus an `Experiments` block and a page section that varies on a test. */
function snapshotWith(experiments: Record<string, unknown> | undefined): Snapshot {
  const base = docsSnapshot();
  const blocks: Snapshot["blocks"] = {
    ...base.blocks,
    BuyButton: {
      __resolveType: "multivariate",
      experiment: "buy-button",
      variants: [
        {
          rule: { __resolveType: "experiment", name: "buy-button" },
          value: lazy({ __resolveType: "hero", title: "New button" }),
        },
        { rule: { __resolveType: "always" }, value: lazy({ __resolveType: "hero", title: "Old" }) },
      ],
    },
  };
  if (experiments !== undefined) {
    blocks.Experiments = { __resolveType: "experiments", ...experiments };
  }
  return { ...base, blocks };
}

const title = async (client: { resolve: (t: string) => Promise<[unknown, unknown]> }) => {
  const [value] = await client.resolve("BuyButton");
  return (value as { props?: { title?: string } } | undefined)?.props?.title;
};

describe("the experiments block", () => {
  it("exp-01: cms.experiments() reads the release's Experiments block: name → whole percentage", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "buy-button": 50, "hero-copy": 0 }),
    });
    expect({ ...(await cms.experiments()) }).toEqual({ "buy-button": 50, "hero-copy": 0 });
  });

  it("exp-02: with no Experiments block, or one of another type, there are no experiments (never rejects)", async () => {
    expect({
      ...(await createCMS({ blocks: {}, content: snapshotWith(undefined) }).experiments()),
    }).toEqual({});
    resetForTests();
    const other = snapshotWith(undefined);
    other.blocks.Experiments = { __resolveType: "seo", title: "x", description: "y" };
    expect({
      ...(await createCMS({ blocks: docsBlocks(), content: other }).experiments()),
    }).toEqual({});
  });

  it("exp-03: `experiments` and `experiment` are reserved names, like every built-in", async () => {
    const { RESERVED_NAMES } = await import("../builtins/index");
    expect(RESERVED_NAMES.has("experiments")).toBe(true);
    expect(RESERVED_NAMES.has("experiment")).toBe(true);
    expect(RESERVED_NAMES.has("Experiments")).toBe(false); // the saved block's name, like CMS
  });

  it("exp-04: two arms only; 0 puts nobody in, 100 everybody, anything between splits", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ off: 0, all: 100 }) });
    const experiments = await cms.experiments();
    for (let i = 0; i < 200; i++) {
      const { assignments } = assign(experiments);
      expect(assignments.off).toBe(false);
      expect(assignments.all).toBe(true);
    }
  });
});

describe("the experiment matcher", () => {
  it("exp-05: true when the client's assignments put the visitor in the named test", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "buy-button": 50 }) });
    expect(await title(cms.forRelease({ assignments: { "buy-button": true } }))).toBe("New button");
    expect(await title(cms.forRelease({ assignments: { "buy-button": false } }))).toBe("Old");
  });

  it("exp-06: false for an unknown name, and for a client created without assignments", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "buy-button": 50 }) });
    expect(await title(cms.forRelease({ assignments: { other: true } }))).toBe("Old");
    expect(await title(cms.forRelease())).toBe("Old");
    expect(await title(cms.forRelease({}))).toBe("Old");
  });

  it("exp-07: assignments belong to one client: never shared between clients, copied when it is created", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "buy-button": 50 }) });
    const mine = { "buy-button": true };
    const inside = cms.forRelease({ assignments: mine });
    const outside = cms.forRelease({ assignments: { "buy-button": false } });
    const none = cms.forRelease();
    mine["buy-button"] = false; // the caller's object changing later changes no client
    const titles = await Promise.all([title(inside), title(outside), title(none)]);
    expect(titles).toEqual(["New button", "Old", "Old"]);
  });

  it("exp-08: the assignments come from assign() over cms.experiments(), per request", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "buy-button": 100 }) });
    const { assignments } = assign(await cms.experiments());
    expect(await title(cms.forRelease({ assignments }))).toBe("New button");
  });

  it("exp-12: false for a name the client's Experiments block doesn't have, even when the assignments say true", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ "hero-copy": 50 }) });
    expect(await title(cms.forRelease({ assignments: { "buy-button": true } }))).toBe("Old");
  });

  it("exp-13: with no Experiments block, or one of another type, every experiment rule is false", async () => {
    const none = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    expect(await title(none.forRelease({ assignments: { "buy-button": true } }))).toBe("Old");
    resetForTests();
    const other = snapshotWith(undefined);
    other.blocks.Experiments = { __resolveType: "seo", "buy-button": 50 };
    const cms = createCMS({ blocks: docsBlocks(), content: other });
    expect(await title(cms.forRelease({ assignments: { "buy-button": true } }))).toBe("Old");
  });

  it("exp-09: a block map's own `experiment` replaces the built-in, as for every built-in", async () => {
    const cms = createCMS({
      blocks: { ...docsBlocks(), experiment: () => true },
      content: snapshotWith({ "buy-button": 0 }),
    });
    expect(await title(cms.forRelease())).toBe("New button");
  });
});

describe("drafts", () => {
  it("exp-10: cms.experiments(pointer) reads the draft's Experiments, so a test created in a draft runs in its preview", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    const pointer = studio.draft({
      set: {
        Experiments: { __resolveType: "experiments", "buy-button": 100 },
        BuyButton: snapshotWith(undefined).blocks.BuyButton,
      },
    });
    expect({ ...(await cms.experiments()) }).toEqual({}); // the release has none
    const experiments = await cms.experiments(pointer);
    expect({ ...experiments }).toEqual({ "buy-button": 100 });
    const { assignments } = assign(experiments);
    expect(await title(cms.forDraft(pointer, { assignments }))).toBe("New button");
    expect(await title(cms.forDraft(pointer))).toBe("Old");
  });

  it("exp-14: a draft client reads Experiments from the draft: a test only in the draft is on in its preview and off on the release", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const release = snapshotWith(undefined);
    const cms = createCMS({ blocks: docsBlocks(), content: release });
    const pointer = studio.draft({
      set: { Experiments: { __resolveType: "experiments", "buy-button": 50 } },
    });
    const assignments = { "buy-button": true };
    expect(await title(cms.forDraft(pointer, { assignments }))).toBe("New button");
    expect(await title(cms.forRelease({ assignments }))).toBe("Old");
  });

  it("exp-11: forDraft still takes the pointer alone; the options are optional", () => {
    const cms = createCMS({ blocks: {}, content: snapshotWith(undefined) });
    expect(cms.forDraft.length).toBe(1);
    expect(cms.forRelease.length).toBe(0);
  });
});
