// @vitest-environment node
/**
 * Campaign dates as content (built-in-blocks#date-windows,
 * matchers-and-variants#date, api-reference#preview-links): the saved block
 * `campaigns` of the built-in type `date-windows`, the built-in `date` rule
 * that names a campaign, and what a Studio preview link sets besides the
 * version (the moment it shows, the tests it forces). One test per claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "../cms";
import { currentClient } from "../current";
import { formatDraftPointer, parseDraftPointer } from "../draft";
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
    Banner: banner({ __resolveType: "date", campaign: "black-friday" }),
    ...extra,
  };
  if (campaigns !== undefined) blocks.campaigns = { __resolveType: "date-windows", ...campaigns };
  return { ...base, blocks };
}

const title = async (client: Client, name = "Banner") => {
  const [value] = await client.resolve(name);
  return (value as { props?: { title?: string } } | undefined)?.props?.title;
};

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });

describe("the saved block campaigns", () => {
  it("cmp-01: resolving it gives each campaign and whether it runs at client.now, never a date", async () => {
    at(DURING);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY, xmas: { start: "2026-12-24" } }),
    });
    const [campaigns, error] = await cms.client().resolve("campaigns");
    expect(error).toBeNull();
    expect({ ...(campaigns as object) }).toEqual({ "black-friday": true, xmas: false });
  });

  it("cmp-02: date-windows and date are reserved names; campaigns stays free", async () => {
    const { RESERVED_NAMES } = await import("../builtins/index");
    expect(RESERVED_NAMES.has("date-windows")).toBe(true);
    expect(RESERVED_NAMES.has("date")).toBe(true);
    expect(RESERVED_NAMES.has("campaigns")).toBe(false);
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

describe("the date rule", () => {
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

  it("cmp-07: there are no inline dates: a rule with { start, end } and no campaign is false", async () => {
    at(DURING);
    const content = snapshotWith(
      { "black-friday": BLACK_FRIDAY },
      {
        Inline: banner({ __resolveType: "date", ...BLACK_FRIDAY }),
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
    const cms = createCMS({ blocks: { ...docsBlocks(), "date-windows": windows }, content });
    const client = cms.client();
    await client.resolve("Page");
    await client.resolve("Banner");
    expect(windows).toHaveBeenCalledTimes(1);
  });

  it("cmp-09: one client shows one moment: a client keeps the time it was created at", async () => {
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
      set: { campaigns: { __resolveType: "date-windows", "black-friday": BLACK_FRIDAY } },
    });
    expect(await title(cms.client({ version: pointer }))).toBe("Sale");
    expect(await title(cms.client())).toBe("Regular");
  });
});

describe("the preview link: the moment and the tests it forces", () => {
  const OLD = "1".repeat(40);
  const SCHEMA = "a".repeat(64);

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

  it("pv-01: a draft pointer carries __at and __test, lifted out of its path, and formats back the same", () => {
    const pointer = {
      host: "delivery.decocms.com",
      path: "/sites/acme/drafts/x.json",
      version: "v1",
      at: "2026-11-28T09:00:00-03:00",
      tests: { "hero-copy": true, "pdp-cta": false },
    };
    const text = formatDraftPointer(pointer);
    expect(text).toBe(
      "delivery.decocms.com/sites/acme/drafts/x.json" +
        "?__at=2026-11-28T09%3A00%3A00-03%3A00&__test=hero-copy%3Don&__test=pdp-cta%3Doff@v1",
    );
    expect(parseDraftPointer(text)).toEqual(pointer);
  });

  it("pv-02: __at sets client.now, so campaigns follow the preview's moment", async () => {
    at(BEFORE);
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const draft = parseDraftPointer(studio.draft({}));
    if (draft === null) throw new Error("the fake Studio's pointer doesn't parse");
    const version = formatDraftPointer({ ...draft, at: "2026-11-28T09:00:00-03:00" });
    const client = cms.client({ version });
    expect(client.now.toISOString()).toBe("2026-11-28T12:00:00.000Z");
    expect(client.version).toBe(version);
    expect(await title(client)).toBe("Sale");
    expect(await title(cms.client())).toBe("Regular");
  });

  it("pv-03: __test forces a test on or off over the visitor's answer, with or without a visitor", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const content = snapshotWith(undefined);
    content.blocks.experiments = { __resolveType: "split-traffic", "hero-copy": 50, other: 100 };
    const cms = createCMS({ blocks: docsBlocks(), content });
    const draft = parseDraftPointer(studio.draft({}));
    if (draft === null) throw new Error("the fake Studio's pointer doesn't parse");
    const forced = (tests: Record<string, boolean>) => formatDraftPointer({ ...draft, tests });
    const answers = async (client: Client) => ({
      ...((await client.resolve("experiments"))[0] as object),
    });

    expect(await answers(cms.client({ visitor: LOW }))).toEqual({ "hero-copy": true, other: true });
    expect(
      await answers(cms.client({ visitor: LOW, version: forced({ "hero-copy": false }) })),
    ).toEqual({ "hero-copy": false, other: true });
    expect(await answers(cms.client({ version: forced({ "hero-copy": true }) }))).toEqual({
      "hero-copy": true,
      other: false,
    });
    // A test the experiments block doesn't have isn't added.
    expect(
      await answers(cms.client({ visitor: newVisitor(), version: forced({ gone: true }) })),
    ).not.toHaveProperty("gone");
  });

  it("pv-04: an old release's SHA carries the same parameters: <sha>?__at=…&__test=…", async () => {
    at(BEFORE);
    delivery();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { ...snapshotWith(undefined), schemaHash: SCHEMA },
      site: "acme",
    });
    const version = `${OLD}?__at=${encodeURIComponent("2026-11-28T09:00:00-03:00")}&__test=${encodeURIComponent("hero-copy=on")}`;
    const client = cms.client({ version });
    expect(client.now.toISOString()).toBe("2026-11-28T12:00:00.000Z");
    expect(await title(client)).toBe("Sale");
    expect({ ...((await client.resolve("experiments"))[0] as object) }).toEqual({
      "hero-copy": true,
    });
    expect(await client.revision()).toBe(OLD);
  });

  it("pv-05: read from a Studio link and its cookie on the preview hosts only, as drafts are", async () => {
    const request = (url: string, cookie?: string) =>
      new Request(url, cookie ? { headers: { cookie } } : {});
    const version = `${OLD}?__at=${encodeURIComponent("2026-11-28T09:00:00Z")}`;
    const link = `?__draft=${encodeURIComponent(version)}`;
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { hosts: ["preview.example.com"] },
    });
    expect(await cms.readVersion(request(`https://preview.example.com/${link}`))).toBe(version);
    const cookie = await cms.draftCookie(request(`https://preview.example.com/${link}`));
    const value = cookie?.split(";")[0] ?? "";
    expect(await cms.readVersion(request("https://preview.example.com/", value))).toBe(version);
    expect(await cms.readVersion(request(`https://shop.example.com/${link}`))).toBeNull();
  });

  it("pv-06: a preview parameter that doesn't parse makes the link no version at all", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const request = (version: string) =>
      new Request(`https://shop.example.com/?__draft=${encodeURIComponent(version)}`);
    for (const bad of [
      `${OLD}?__at=tomorrow`,
      `${OLD}?__at=2026-11-28`, // a moment needs a time and an offset
      `${OLD}?__test=hero-copy%3Dmaybe`,
      `${OLD}?__at=2026-11-28T09%3A00Z&__at=2026-11-29T09%3A00Z`,
      `${OLD}?other=1`,
      "delivery.decocms.com/d.json?__at=soon@v1",
    ]) {
      expect(await cms.readVersion(request(bad)), bad).toBeNull();
      const [, error] = await cms.client({ version: bad }).resolve("SummerSEO");
      expect(error?.code, bad).toBe("LOADER_FAILED");
    }
  });

  it("pv-07: every preview of one draft shares one fetched body, whatever moment or tests it sets", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snapshotWith({ "black-friday": BLACK_FRIDAY }),
    });
    const draft = parseDraftPointer(studio.draft({}));
    if (draft === null) throw new Error("the fake Studio's pointer doesn't parse");
    await Promise.all([
      cms
        .client({ version: formatDraftPointer({ ...draft, at: "2026-11-28T09:00:00Z" }) })
        .resolve("Banner"),
      cms
        .client({ version: formatDraftPointer({ ...draft, tests: { a: true } }) })
        .resolve("Banner"),
      cms.client({ version: formatDraftPointer(draft) }).resolve("Banner"),
    ]);
    expect(studio.requests).toHaveLength(1);
  });
});
