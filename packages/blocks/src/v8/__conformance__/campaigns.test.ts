// @vitest-environment node
/**
 * Campaign dates as content (built-in-blocks#calendar,
 * matchers-and-variants#campaign, api-reference#preview-links): the saved
 * block `campaigns` of the built-in type `calendar`, the built-in `campaign`
 * rule that names one, the client's `date`, `experiments` and `campaigns`,
 * and what a Studio preview link sets besides the version (the moment it
 * shows, the tests and campaigns it switches). One test per claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "../cms";
import { currentClient } from "../current";
import { parseDraftPointer, parseVersion } from "../draft";
import { newVisitor, type Visitor } from "../experiments";
import { docsBlocks, docsSnapshot, fakeStudio } from "../testFixtures";
import type { Blocks, Client, Snapshot } from "../types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

const BLACK_FRIDAY = { start: "2026-11-27T00:00:00-03:00", end: "2026-12-01T23:59:59-03:00" };
const DURING = "2026-11-28T12:00:00Z";
const BEFORE = "2026-11-20T12:00:00Z";

/** `hero-copy` rolls 0.93 for this visitor (pinned in experiments.test.ts): in at 50%. */
const LOW: Visitor = { id: "Zm9vYmFyYmF6cXV4MTIzNA", active: [], inactiveDrawn: [], pct: {} };

/** A banner that says "Sale" while `campaign` runs, "Regular" otherwise. */
const banner = (rule: unknown) => ({
  __resolveType: "multivariate",
  variants: [
    { rule, value: lazy({ __resolveType: "hero", title: "Sale" }) },
    { rule: { __resolveType: "always" }, value: lazy({ __resolveType: "hero", title: "Regular" }) },
  ],
});

/** The docs' content, a saved `campaigns` block and a `Banner` on `black-friday`. */
function snapshotWith(
  campaigns: Record<string, unknown> | undefined,
  extra: Snapshot["blocks"] = {},
): Snapshot {
  const base = docsSnapshot();
  const blocks: Snapshot["blocks"] = {
    ...base.blocks,
    Banner: banner({ __resolveType: "campaign", name: "black-friday" }),
    ...extra,
  };
  if (campaigns !== undefined) blocks.campaigns = { __resolveType: "calendar", ...campaigns };
  return { ...base, blocks };
}

const title = async (client: Client, name = "Banner") => {
  const [value] = await client.resolve(name);
  return (value as { props?: { title?: string } } | undefined)?.props?.title;
};

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });

describe("the saved block campaigns", () => {
  it("cmp-01: resolving it gives each campaign and whether it runs at client.date, never a date", async () => {
    at(DURING);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY, xmas: { start: "2026-12-24" } }),
    });
    const [campaigns, error] = await cms.client().resolve("campaigns");
    expect(error).toBeNull();
    expect({ ...(campaigns as object) }).toEqual({ "black-friday": true, xmas: false });
  });

  it("cmp-02: calendar and campaign are reserved names; campaigns, date and date-windows stay free", async () => {
    const { RESERVED_NAMES } = await import("../builtins/index");
    expect(RESERVED_NAMES.has("calendar")).toBe(true);
    expect(RESERVED_NAMES.has("campaign")).toBe(true);
    for (const free of ["campaigns", "date", "date-windows"]) {
      expect(RESERVED_NAMES.has(free), free).toBe(false);
    }
  });

  it("cmp-03: a component's prop filled with the campaigns block gets the true/false map", async () => {
    at(DURING);
    const hero = vi.fn((props: { campaigns: Record<string, boolean> }) => props);
    const content = snapshotWith(
      { "black-friday": BLACK_FRIDAY },
      {
        Hero: { __resolveType: "my-hero", campaigns: { __resolveType: "campaigns" } },
      },
    );
    const cms = createCMS({ blocks: { ...docsBlocks(), "my-hero": hero }, content });
    await cms.client().resolve("Hero");
    expect({ ...hero.mock.calls[0][0].campaigns }).toEqual({ "black-friday": true });
  });

  it("cmp-04: a site's own block reads a campaign through currentClient()", async () => {
    at(DURING);
    const blocks: Blocks = {
      ...docsBlocks(),
      "free-shipping-from": ({ min }: { min: number }) =>
        currentClient()
          .resolve<Record<string, boolean>>("campaigns")
          .then(([c]) => (c?.["black-friday"] ? 0 : min)),
    };
    const content = snapshotWith(
      { "black-friday": BLACK_FRIDAY },
      {
        Shipping: { __resolveType: "free-shipping-from", min: 50 },
      },
    );
    const cms = createCMS({ blocks, content });
    expect((await cms.client().resolve("Shipping"))[0]).toBe(0);
    vi.setSystemTime(new Date(BEFORE));
    expect((await cms.client().resolve("Shipping"))[0]).toBe(50);
  });
});

describe("the campaign rule", () => {
  it("cmp-05: true while the named campaign runs, so the variant shows", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    at(DURING);
    expect(await title(cms.client())).toBe("Sale");
    vi.setSystemTime(new Date(BEFORE));
    expect(await title(cms.client())).toBe("Regular");
  });

  it("cmp-06: false for a campaign the block doesn't have, and with no campaigns block, never an error", async () => {
    at(DURING);
    const other = createCMS({ blocks: docsBlocks(), content: snapshotWith({ xmas: {} }) });
    expect(await title(other.client())).toBe("Regular");
    resetForTests();
    const none = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    const [, error] = await none.client().resolve("Banner");
    expect(error).toBeNull();
    expect(await title(none.client())).toBe("Regular");
  });

  it("cmp-07: there are no inline dates: a rule with { start, end } and no name is false", async () => {
    at(DURING);
    const content = snapshotWith(
      { "black-friday": BLACK_FRIDAY },
      {
        Inline: banner({ __resolveType: "campaign", ...BLACK_FRIDAY }),
      },
    );
    const cms = createCMS({ blocks: docsBlocks(), content });
    expect(await title(cms.client(), "Inline")).toBe("Regular");
  });

  it("cmp-08: campaigns are decided once per client, at its moment, however many rules ask", async () => {
    at(DURING);
    const windows = vi.fn((input: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(input).map((name) => [name, true])),
    );
    const content = snapshotWith(
      { "black-friday": BLACK_FRIDAY },
      {
        Page: {
          __resolveType: "page",
          name: "p",
          path: "/p",
          sections: [{ __resolveType: "Banner" }, { __resolveType: "Banner" }],
        },
      },
    );
    const cms = createCMS({ blocks: { ...docsBlocks(), calendar: windows }, content });
    const client = cms.client();
    await client.resolve("Page");
    await client.resolve("Banner");
    expect(windows).toHaveBeenCalledTimes(1);
  });

  it("cmp-09: one client shows one moment: without a date, a client keeps the time it was created at", async () => {
    at(BEFORE);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const client = cms.client();
    vi.setSystemTime(new Date(DURING));
    expect(await title(client)).toBe("Regular");
    expect(await title(cms.client())).toBe("Sale");
  });

  it("cmp-10: a campaign made in a draft runs in that draft's preview", async () => {
    at(DURING);
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    const pointer = studio.draft({
      set: { campaigns: { __resolveType: "calendar", "black-friday": BLACK_FRIDAY } },
    });
    expect(await title(cms.client({ version: pointer }))).toBe("Sale");
    expect(await title(cms.client())).toBe("Regular");
  });
});

describe("a client's date and the campaigns it is given", () => {
  it("cmp-11: cms.client({ date }) checks the windows at that moment, and client.date is it", async () => {
    at(BEFORE);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const client = cms.client({ date: new Date(DURING) });
    expect(client.date.toISOString()).toBe(new Date(DURING).toISOString());
    expect(await title(client)).toBe("Sale");
    expect(await title(cms.client())).toBe("Regular");
  });

  it("cmp-12: cms.client({ campaigns }) wins name by name; the others are checked at the date", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY, xmas: {} }),
    });
    at(BEFORE);
    const on = cms.client({ campaigns: { "black-friday": true } });
    expect(await title(on)).toBe("Sale");
    expect({ ...((await on.resolve("campaigns"))[0] as object) }).toEqual({
      "black-friday": true,
      xmas: true,
    });
    at(DURING);
    const off = cms.client({ campaigns: { "black-friday": false } });
    expect(await title(off)).toBe("Regular");
    expect({ ...((await off.resolve("campaigns"))[0] as object) }).toEqual({
      "black-friday": false,
      xmas: true,
    });
  });

  it("cmp-13: a name the block doesn't have stays out, even when given", async () => {
    at(DURING);
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith({ xmas: {} }) });
    const client = cms.client({ campaigns: { "black-friday": true, xmas: false } });
    expect({ ...((await client.resolve("campaigns"))[0] as object) }).toEqual({ xmas: false });
    expect(await title(client)).toBe("Regular");
  });

  it("cmp-14: given every test and campaign and no visitor, a client is fully decided", async () => {
    const content = snapshotWith({ "black-friday": BLACK_FRIDAY, xmas: {} });
    content.blocks.experiments = { __resolveType: "split-traffic", "hero-copy": 50, all: 100 };
    const cms = createCMS({ blocks: docsBlocks(), content });
    for (const now of [BEFORE, DURING]) {
      at(now);
      const client = cms.client({
        experiments: { "hero-copy": true, all: false },
        campaigns: { "black-friday": true, xmas: false },
      });
      expect(client.visitor).toBeNull();
      expect({ ...((await client.resolve("experiments"))[0] as object) }).toEqual({
        "hero-copy": true,
        all: false,
      });
      expect({ ...((await client.resolve("campaigns"))[0] as object) }).toEqual({
        "black-friday": true,
        xmas: false,
      });
    }
  });
});

describe("the preview link: the version, the moment and the tests and campaigns it switches", () => {
  const OLD = "1".repeat(40);
  const SCHEMA = "a".repeat(64);
  const enc = encodeURIComponent;

  /** A fake delivery CDN holding the published revision OLD, with campaigns and a test. */
  function delivery() {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== `https://delivery.decocms.com/sites/acme/revisions/${OLD}.json`) {
        return new Response("not found", { status: 404 });
      }
      const { blocks } = snapshotWith({ "black-friday": BLACK_FRIDAY });
      blocks.experiments = { __resolveType: "split-traffic", "hero-copy": 0 };
      return Response.json({ revision: OLD, schemaHash: SCHEMA, blocks });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("pv-01: parseVersion lifts __at, __test and __campaign out of a draft pointer's query; the version keeps the rest", () => {
    const pointer = "delivery.decocms.com/sites/acme/drafts/x.json?v=2";
    const link =
      `delivery.decocms.com/sites/acme/drafts/x.json?__at=${enc("2026-11-28T09:00:00-03:00")}` +
      `&v=2&__test=${enc("hero-copy=on")}&__test=${enc("pdp-cta=off")}` +
      `&__campaign=${enc("black-friday=on")}@v1`;
    const read = parseVersion(link);
    expect(read?.version).toBe(`${pointer}@v1`);
    expect(read?.date?.toISOString()).toBe("2026-11-28T12:00:00.000Z");
    expect({ ...read?.experiments }).toEqual({ "hero-copy": true, "pdp-cta": false });
    expect({ ...read?.campaigns }).toEqual({ "black-friday": true });
    expect(parseVersion(`${pointer}@v1`)).toEqual({ version: `${pointer}@v1` });
    expect(parseVersion(OLD)).toEqual({ version: OLD });
  });

  it("pv-02: a version is only a version: a pointer or SHA still carrying __at, __test or __campaign isn't one", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({ blocks: docsBlocks(), content: snapshotWith(undefined) });
    const pointer = studio.draft({});
    const [location, version] = [
      pointer.slice(0, pointer.lastIndexOf("@")),
      pointer.slice(pointer.lastIndexOf("@")),
    ];
    const sep = location.includes("?") ? "&" : "?";
    for (const bad of [
      `${location}${sep}__at=${enc("2026-11-28T09:00:00Z")}${version}`,
      `${location}${sep}__test=${enc("hero-copy=on")}${version}`,
      `${location}${sep}__campaign=${enc("black-friday=on")}${version}`,
      `${OLD}?__at=${enc("2026-11-28T09:00:00Z")}`,
    ]) {
      expect(parseDraftPointer(bad), bad).toBeNull();
      const [, error] = await cms.client({ version: bad }).resolve("SummerSEO");
      expect(error?.code, bad).toBe("LOADER_FAILED");
    }
  });

  it("pv-03: spread into cms.client, __at sets client.date, so campaigns follow the preview's moment", async () => {
    at(BEFORE);
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const pointer = studio.draft({});
    const tail = pointer.lastIndexOf("@");
    const sep = pointer.slice(0, tail).includes("?") ? "&" : "?";
    const read = parseVersion(
      `${pointer.slice(0, tail)}${sep}__at=${enc("2026-11-28T09:00:00-03:00")}${pointer.slice(tail)}`,
    );
    const client = cms.client({ ...read });
    expect(client.date.toISOString()).toBe("2026-11-28T12:00:00.000Z");
    expect(client.version).toBe(pointer);
    expect(await title(client)).toBe("Sale");
    expect(await title(cms.client())).toBe("Regular");
  });

  it("pv-04: __test switches a test over the visitor's answer, with or without a visitor, even one at 0%", async () => {
    const content = snapshotWith(undefined);
    content.blocks.experiments = {
      __resolveType: "split-traffic",
      "hero-copy": 50,
      other: 100,
      dark: 0,
    };
    const cms = createCMS({ blocks: docsBlocks(), content });
    const answers = async (client: Client) => ({
      ...((await client.resolve("experiments"))[0] as object),
    });
    const switched = (tests: string[]) =>
      parseVersion(`${OLD}?${tests.map((t) => `__test=${enc(t)}`).join("&")}`)?.experiments;

    expect(await answers(cms.client({ visitor: LOW }))).toEqual({
      "hero-copy": true,
      other: true,
      dark: false,
    });
    expect(
      await answers(cms.client({ visitor: LOW, experiments: switched(["hero-copy=off"]) })),
    ).toEqual({ "hero-copy": false, other: true, dark: false });
    expect(
      await answers(cms.client({ experiments: switched(["hero-copy=on", "dark=on"]) })),
    ).toEqual({
      "hero-copy": true,
      other: false,
      dark: true,
    });
    // A test the experiments block doesn't have isn't added.
    expect(
      await answers(cms.client({ visitor: newVisitor(), experiments: switched(["gone=on"]) })),
    ).not.toHaveProperty("gone");
  });

  it("pv-05: an old release's SHA carries the same parameters: <sha>?__at=…&__test=…", async () => {
    at(BEFORE);
    delivery();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { ...snapshotWith(undefined), schemaHash: SCHEMA },
      site: "acme",
    });
    const read = parseVersion(
      `${OLD}?__at=${enc("2026-11-28T09:00:00-03:00")}&__test=${enc("hero-copy=on")}`,
    );
    expect(read?.version).toBe(OLD);
    const client = cms.client({ ...read });
    expect(client.date.toISOString()).toBe("2026-11-28T12:00:00.000Z");
    expect(await title(client)).toBe("Sale");
    expect({ ...((await client.resolve("experiments"))[0] as object) }).toEqual({
      "hero-copy": true,
    });
    expect(await client.revision()).toBe(OLD);
  });

  it("pv-06: cms.readVersion reads a Studio link and its cookie on the preview hosts only, as drafts are", async () => {
    const request = (url: string, cookie?: string) =>
      new Request(url, cookie ? { headers: { cookie } } : {});
    const value = `${OLD}?__at=${enc("2026-11-28T09:00:00Z")}&__campaign=${enc("xmas=off")}`;
    const link = `?__draft=${enc(value)}`;
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { hosts: ["preview.example.com"] },
    });
    const expected = {
      version: OLD,
      date: new Date("2026-11-28T09:00:00Z"),
      campaigns: { xmas: false },
    };
    const read = await cms.readVersion(request(`https://preview.example.com/${link}`));
    expect({ ...read, campaigns: { ...read?.campaigns } }).toEqual(expected);
    expect(await cms.draftPointer(request(`https://preview.example.com/${link}`))).toBe(OLD);
    const cookie = await cms.draftCookie(request(`https://preview.example.com/${link}`));
    const header = cookie?.split(";")[0] ?? "";
    const fromCookie = await cms.readVersion(request("https://preview.example.com/", header));
    expect({ ...fromCookie, campaigns: { ...fromCookie?.campaigns } }).toEqual(expected);
    expect(await cms.readVersion(request(`https://shop.example.com/${link}`))).toBeNull();
  });

  it("pv-07: a preview parameter that doesn't parse makes the link no version at all", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const request = (version: string) =>
      new Request(`https://shop.example.com/?__draft=${enc(version)}`);
    for (const bad of [
      `${OLD}?__at=tomorrow`,
      `${OLD}?__at=2026-11-28`, // a moment needs a time and an offset
      `${OLD}?__test=hero-copy%3Dmaybe`,
      `${OLD}?__campaign=xmas`,
      `${OLD}?__at=2026-11-28T09%3A00Z&__at=2026-11-29T09%3A00Z`,
      `${OLD}?other=1`,
      "delivery.decocms.com/d.json?__at=soon@v1",
    ]) {
      expect(parseVersion(bad), bad).toBeNull();
      expect(await cms.readVersion(request(bad)), bad).toBeNull();
    }
  });

  it("pv-08: every preview of one draft shares one fetched body, whatever moment, tests or campaigns it sets", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const version = studio.draft({});
    await Promise.all([
      cms.client({ version, date: new Date(DURING) }).resolve("Banner"),
      cms.client({ version, experiments: { a: true } }).resolve("Banner"),
      cms.client({ version, campaigns: { "black-friday": false } }).resolve("Banner"),
      cms.client({ version }).resolve("Banner"),
    ]);
    expect(studio.requests).toHaveLength(1);
  });
});
