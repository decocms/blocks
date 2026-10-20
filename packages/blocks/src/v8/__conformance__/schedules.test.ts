// @vitest-environment node
/**
 * Campaign dates as content (built-in-blocks#schedules, matchers-and-variants#schedule):
 * the built-in type `schedules`, saved as the well-known block `Schedules`
 * (shown as Campaigns), and the built-in `schedule` matcher, which is the
 * built-in `date` matcher over a named window. One test per claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "../cms";
import { docsBlocks, docsSnapshot, fakeStudio } from "../testFixtures";
import type { Snapshot } from "../types";

beforeEach(() => {
  resetForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

const BLACK_FRIDAY = { start: "2026-11-27T00:00:00-03:00", end: "2026-11-30T00:00:00-03:00" };

/** A banner that shows the campaign's title while the rule is true. */
function banner(rule: unknown) {
  return {
    __resolveType: "multivariate",
    variants: [
      { rule, value: lazy({ __resolveType: "hero", title: "Campaign" }) },
      {
        rule: { __resolveType: "always" },
        value: lazy({ __resolveType: "hero", title: "Default" }),
      },
    ],
  };
}

/** The docs' content plus a `Schedules` block and a banner that varies on `black-friday`. */
function snapshotWith(schedules: Record<string, unknown> | undefined): Snapshot {
  const base = docsSnapshot();
  const blocks: Snapshot["blocks"] = {
    ...base.blocks,
    Banner: banner({ __resolveType: "schedule", name: "black-friday" }),
  };
  if (schedules !== undefined) blocks.Schedules = { __resolveType: "schedules", ...schedules };
  return { ...base, blocks };
}

const title = async (
  client: { resolve: (t: unknown) => Promise<[unknown, unknown]> },
  target: unknown = "Banner",
) => {
  const [value, error] = await client.resolve(target);
  expect(error).toBeNull();
  return (value as { props?: { title?: string } } | undefined)?.props?.title;
};

describe("the schedules block", () => {
  it("sch-01: Schedules maps each campaign to its window, and resolves to it as saved", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({
        "black-friday": BLACK_FRIDAY,
        launch: { start: BLACK_FRIDAY.start },
      }),
    });
    const [value, error] = await cms.forRelease().resolve("Schedules");
    expect(error).toBeNull();
    expect(value).toEqual({ "black-friday": BLACK_FRIDAY, launch: { start: BLACK_FRIDAY.start } });
  });

  it("sch-02: `schedules` and `schedule` are reserved names; `Schedules` is the saved block's name, like CMS", async () => {
    const { RESERVED_NAMES } = await import("../builtins/index");
    expect(RESERVED_NAMES.has("schedules")).toBe(true);
    expect(RESERVED_NAMES.has("schedule")).toBe(true);
    expect(RESERVED_NAMES.has("Schedules")).toBe(false);
  });
});

describe("the schedule matcher", () => {
  it("sch-03: true from the campaign's start (inclusive) until its end (exclusive)", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const at = async (iso: string) => {
      vi.setSystemTime(new Date(iso));
      return title(cms.forRelease());
    };
    expect(await at("2026-11-27T02:59:59.999Z")).toBe("Default");
    expect(await at("2026-11-27T03:00:00Z")).toBe("Campaign"); // start, with its offset
    expect(await at("2026-11-30T02:59:59.999Z")).toBe("Campaign");
    expect(await at("2026-11-30T03:00:00Z")).toBe("Default"); // end itself doesn't match
  });

  it("sch-04: it is the built-in date matcher over the named window: the same answer at every moment", async () => {
    const windows = {
      both: BLACK_FRIDAY,
      from: { start: BLACK_FRIDAY.start },
      until: { end: BLACK_FRIDAY.end },
      open: {},
      date: { start: "2026-11-28", end: "2026-11-29" },
      typo: { start: "not a date" },
    };
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(windows) });
    for (const iso of [
      "2026-11-01T00:00:00Z",
      "2026-11-27T03:00:00Z",
      "2026-11-28T12:00:00Z",
      "2026-12-25T00:00:00Z",
    ]) {
      vi.setSystemTime(new Date(iso));
      const client = cms.forRelease();
      for (const [name, window] of Object.entries(windows)) {
        const named = await title(client, banner({ __resolveType: "schedule", name }));
        const inline = await title(client, banner({ __resolveType: "date", ...window }));
        expect(named, `${name} at ${iso}`).toBe(inline);
      }
    }
  });

  it("sch-05: false for a name the Schedules block doesn't have, and with no Schedules block", async () => {
    let cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "cyber-monday": BLACK_FRIDAY }),
    });
    expect(await title(cms.forRelease())).toBe("Default");
    resetForTests();
    cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    expect(await title(cms.forRelease())).toBe("Default");
  });

  it("sch-06: a Schedules block of another type is not read: every schedule rule is false", async () => {
    const content = snapshotWith(undefined);
    content.blocks.Schedules = { __resolveType: "seo", "black-friday": BLACK_FRIDAY };
    const cms = createCMS({
      blocks: { ...docsBlocks(), seo: (props: unknown) => props },
      content,
    });
    expect(await title(cms.forRelease())).toBe("Default");
  });

  it("sch-07: a bound that isn't a date never matches, so a typo can't switch a campaign on", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": { start: 20261127 } }),
    });
    expect(await title(cms.forRelease())).toBe("Default");
  });

  it("sch-08: inline date rules keep working next to schedule rules", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    expect(await title(cms.forRelease(), banner({ __resolveType: "date", ...BLACK_FRIDAY }))).toBe(
      "Campaign",
    );
  });

  it("sch-09: a block map's own `schedule` replaces the built-in, as for every built-in", async () => {
    const cms = createCMS({
      blocks: { ...docsBlocks(), schedule: () => true },
      content: snapshotWith(undefined),
    });
    expect(await title(cms.forRelease())).toBe("Campaign");
  });
});

describe("drafts", () => {
  it("sch-10: a draft client reads the draft's Schedules, so a campaign created in a draft runs in its preview", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    const pointer = studio.draft({
      set: { Schedules: { __resolveType: "schedules", "black-friday": BLACK_FRIDAY } },
    });
    expect(await title(cms.forRelease())).toBe("Default"); // the release has no campaign
    expect(await title(cms.forDraft(pointer))).toBe("Campaign");
  });

  it("sch-11: a draft that moves a campaign's dates moves them in its preview only", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const pointer = studio.draft({
      set: {
        Schedules: {
          __resolveType: "schedules",
          "black-friday": { start: "2026-12-01T00:00:00-03:00" },
        },
      },
    });
    expect(await title(cms.forDraft(pointer))).toBe("Default");
    expect(await title(cms.forRelease())).toBe("Campaign");
  });
});
