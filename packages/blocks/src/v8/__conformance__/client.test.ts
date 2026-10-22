// @vitest-environment node
/**
 * The client carries its inputs (api-reference#cms-client,
 * api-reference#current-client): `cms.client({ visitor, version })`, the
 * three kinds of version, `client.visitor`/`version`/`date`,
 * `cms.readVersion`, and `currentClient()`. One test per claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "../cms";
import { currentClient } from "../current";
import { newVisitor } from "../experiments";
import { docsBlocks, docsSnapshot, fakeStudio } from "../testFixtures";
import type { Blocks, Client, Lazy, Snapshot } from "../types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ORIGIN = "https://delivery.decocms.com";
const SCHEMA = "a".repeat(64);
const OLD = "1".repeat(40);
const OTHER = "2".repeat(40);

/** The bundled content, built with SCHEMA. */
function bundled(): Snapshot {
  return { ...docsSnapshot("3".repeat(40)), schemaHash: SCHEMA };
}

/** A fake delivery CDN holding published revisions. */
function delivery(revisions: Record<string, { title: string; schemaHash?: string }>) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const [sha, { title, schemaHash = SCHEMA }] of Object.entries(revisions)) {
      if (url === `${ORIGIN}/sites/acme/revisions/${sha}.json`) {
        return Response.json({
          revision: sha,
          schemaHash,
          blocks: { SummerSEO: { __resolveType: "seo", title, description: "d" } },
        });
      }
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const seoTitle = async (client: Client) =>
  ((await client.resolve("SummerSEO"))[0] as { title?: string } | null)?.title;

describe("cms.client", () => {
  it("cl-01: carries what it was created with: client.visitor, and client.version, the release SHA it reads or the draft", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot("rev-1") });
    const visitor = newVisitor();
    const client = cms.client({ visitor, version: OLD });
    expect(client.visitor).toEqual(visitor);
    expect(client.version).toBe(OLD);
    const current = cms.client();
    expect(current.visitor).toBeNull();
    expect(current.version).toBeUndefined(); // nothing loaded yet
    await current.resolve("SummerSEO");
    expect(current.version).toBe("rev-1");
  });

  it("cl-02: client.date is the date passed in, else the moment the client was created, the same for its whole life", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T12:00:00Z") });
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const client = cms.client();
    vi.setSystemTime(new Date("2026-12-25T00:00:00Z"));
    expect(client.date.toISOString()).toBe("2026-11-27T12:00:00.000Z");
    client.date.setFullYear(1999); // a copy: changing it changes nothing
    expect(client.date.toISOString()).toBe("2026-11-27T12:00:00.000Z");
    expect(cms.client().date.toISOString()).toBe("2026-12-25T00:00:00.000Z");
    const given = new Date("2026-01-01T00:00:00Z");
    const dated = cms.client({ date: given });
    given.setFullYear(1999); // the client keeps its own copy
    expect(dated.date.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(cms.client({ date: new Date("not a date") }).date.toISOString()).toBe(
      "2026-12-25T00:00:00.000Z",
    );
  });

  it("cl-03: version undefined reads the current release; forRelease() is cms.client()", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot("rev-1") });
    expect(await cms.client().revision()).toBe("rev-1");
    expect(await cms.client({ version: null }).revision()).toBe("rev-1");
    expect(await cms.forRelease().revision()).toBe("rev-1");
    expect(cms.forRelease.length).toBe(0);
  });

  it("cl-04: a draft pointer reads the draft over the current release; forDraft(p) is cms.client({ version: p })", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const pointer = studio.draft({
      set: { SummerSEO: { __resolveType: "seo", title: "Draft", description: "d" } },
    });
    expect(await seoTitle(cms.client({ version: pointer }))).toBe("Draft");
    expect(await seoTitle(cms.forDraft(pointer))).toBe("Draft");
    expect(cms.forDraft(pointer).version).toBe(pointer);
    expect(await seoTitle(cms.client())).toBe("Sunny!");
  });

  it("cl-05: a commit SHA reads that published release from sites/<site>/revisions/<sha>.json", async () => {
    const fetch = delivery({ [OLD]: { title: "Last week" } });
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: "acme" });
    const client = cms.client({ version: OLD });
    expect(await seoTitle(client)).toBe("Last week");
    expect(await client.revision()).toBe(OLD);
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain(
      `${ORIGIN}/sites/acme/revisions/${OLD}.json`,
    );
    expect(await seoTitle(cms.client())).toBe("Sunny!"); // the live site is untouched
  });

  it("cl-06: an old release is fetched once and kept in memory (a revision never changes)", async () => {
    const fetch = delivery({ [OLD]: { title: "Last week" } });
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: "acme" });
    for (let i = 0; i < 5; i++)
      expect(await seoTitle(cms.client({ version: OLD }))).toBe("Last week");
    const reads = fetch.mock.calls.filter(([url]) => String(url).endsWith(`${OLD}.json`));
    expect(reads).toHaveLength(1);
  });

  it("cl-07: an old release built with another schema is a clear error, never half a page", async () => {
    delivery({ [OTHER]: { title: "Old schema", schemaHash: "b".repeat(64) } });
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: "acme" });
    const [value, error] = await cms.client({ version: OTHER }).resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    expect(error?.message).toMatch(/another schema/);
  });

  it("cl-08: a release that can't be read is LOADER_FAILED, never the current release", async () => {
    delivery({});
    const hosted = createCMS({ blocks: docsBlocks(), content: bundled(), site: "acme" });
    expect((await hosted.client({ version: OTHER }).resolve("SummerSEO"))[1]?.code).toBe(
      "LOADER_FAILED",
    );
    resetForTests();
    const local = createCMS({ blocks: docsBlocks(), content: bundled() });
    expect((await local.client({ version: OTHER }).resolve("SummerSEO"))[1]?.code).toBe(
      "LOADER_FAILED",
    );
  });
});

describe("cms.readVersion", () => {
  const request = (query: string, cookie?: string) =>
    new Request(`https://shop.example.com/p${query}`, cookie ? { headers: { cookie } } : {});

  it("rv-01: reads a draft pointer or a release's commit SHA from a Studio link (?__draft=), then the cookie", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { hosts: ["shop.example.com"] },
    });
    const pointer = "studio.decocms.com/sites/acme/drafts/x.json@v1";
    expect(await cms.readVersion(request(`?__draft=${encodeURIComponent(pointer)}`))).toEqual({
      version: pointer,
    });
    expect(await cms.readVersion(request(`?__draft=${OLD}`))).toEqual({ version: OLD });
    expect(await cms.readVersion(request("", `__deco_draft=${OLD}`))).toEqual({ version: OLD });
    expect(await cms.readVersion(request(""))).toBeNull();
    expect(await cms.readVersion(request("?__draft=junk"))).toBeNull();
    expect(await cms.readVersion(request("?__draft=off", `__deco_draft=${OLD}`))).toBeNull();
  });

  it("rv-02: honoured only on the preview hosts, as drafts are", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { hosts: ["preview.example.com"] },
    });
    expect(await cms.readVersion(request(`?__draft=${OLD}`))).toBeNull();
  });

  it("rv-04: with no remote site and no preview hosts in the release nor in code, every host reads a version; a list, the release's or code's, is enforced", async () => {
    const link = `?__draft=${OLD}`;
    const open = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect((await open.settings()).preview.hosts).toEqual(["*"]);
    expect(await open.readVersion(request(link))).toEqual({ version: OLD });
    expect(await open.draftPointer(request(link))).toBe(OLD);
    expect(await open.draftCookie(request(link))).not.toBeNull();
    // In the release (Studio writes them into its metadata) or in createCMS (code), the list is enforced.
    const content = docsSnapshot();
    content.previewHosts = ["shop.example.com"];
    const inRelease = createCMS({ blocks: docsBlocks(), content });
    expect(await inRelease.readVersion(request(link))).toEqual({ version: OLD });
    const elsewhere = new Request(`https://www.other.com/${link}`);
    expect(await inRelease.readVersion(elsewhere)).toBeNull();
    const inCode = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { hosts: ["*.example.com"] },
    });
    expect(await inCode.readVersion(request(link))).toEqual({ version: OLD });
    expect(await inCode.readVersion(elsewhere)).toBeNull();
    // An empty list: none, on any host; a CMS block's preview field (an earlier version's) doesn't count.
    const none = docsSnapshot();
    none.previewHosts = [];
    none.blocks.CMS = { __resolveType: "cms-settings", preview: { hosts: ["shop.example.com"] } };
    const closed = createCMS({ blocks: docsBlocks(), content: none });
    expect(await closed.readVersion(request(link))).toBeNull();
    expect(await closed.readVersion(request("", `__deco_draft=${OLD}`))).toBeNull();
    expect(await closed.draftCookie(request(link))).toBeNull();
  });

  it("rv-03: draftPointer is readVersion's version alone, under its earlier name; the cookie carries a SHA too", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { hosts: ["shop.example.com"] },
    });
    expect(await cms.draftPointer(request(`?__draft=${OLD}`))).toBe(OLD);
    expect(await cms.draftCookie(request(`?__draft=${OLD}`))).toMatch(
      new RegExp(`^__deco_draft=${OLD};`),
    );
  });
});

describe("currentClient", () => {
  it("cc-01: inside a block function it is the client resolving it, from its first line", async () => {
    const seen: Client[] = [];
    const blocks: Blocks = { ...docsBlocks(), probe: () => seen.push(currentClient()) };
    const content = docsSnapshot();
    content.blocks.Probe = { __resolveType: "probe" };
    const cms = createCMS({ blocks, content });
    const a = cms.client();
    const b = cms.client();
    await Promise.all([a.resolve("Probe"), b.resolve("Probe")]);
    expect(seen).toEqual([a, b]);
  });

  it("cc-02: throws outside a block function", () => {
    expect(() => currentClient()).toThrow(/outside a block function/);
  });

  it("cc-03: survives await where AsyncLocalStorage exists (Node here)", async () => {
    const blocks: Blocks = {
      ...docsBlocks(),
      slow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentClient().visitor?.id;
      },
    };
    const content = docsSnapshot();
    content.blocks.Slow = { __resolveType: "slow" };
    const cms = createCMS({ blocks, content });
    const visitors = [newVisitor(), newVisitor(), newVisitor()];
    const results = await Promise.all(
      visitors.map((visitor) => cms.client({ visitor }).resolve("Slow")),
    );
    expect(results.map(([id]) => id)).toEqual(visitors.map((v) => v.id));
  });

  it("cc-04: without AsyncLocalStorage it is there before the first await", async () => {
    const slot = (globalThis as unknown as Record<symbol, { store: unknown }>)[
      Symbol.for("decocms.blocks.currentClient")
    ];
    const store = slot.store;
    slot.store = undefined; // a browser or React Native
    try {
      const blocks: Blocks = {
        ...docsBlocks(),
        early: async () => {
          const client = currentClient();
          await Promise.resolve();
          return client.visitor?.id;
        },
      };
      const content = docsSnapshot();
      content.blocks.Early = { __resolveType: "early" };
      const cms = createCMS({ blocks, content });
      const visitor = newVisitor();
      expect((await cms.client({ visitor }).resolve("Early"))[0]).toBe(visitor.id);
    } finally {
      slot.store = store;
    }
  });

  it("cc-05: a lazy value called after the resolve returned runs with the same client", async () => {
    const seen: Client[] = [];
    const blocks: Blocks = {
      ...docsBlocks(),
      probe: () => {
        seen.push(currentClient());
        return "ok";
      },
      holder: (props: { later: Lazy<string> }) => props,
    };
    const content = docsSnapshot();
    content.blocks.Holder = {
      __resolveType: "holder",
      later: { __resolveType: "lazy", value: { __resolveType: "probe" } },
    };
    const cms = createCMS({ blocks, content });
    const client = cms.client({ visitor: newVisitor() });
    const [holder] = await client.resolve<{ later: Lazy<string> }>("Holder");
    expect(seen).toEqual([]);
    await cms.client().resolve("Holder"); // another client in between
    expect(await holder?.later()).toBe("ok");
    expect(seen).toEqual([client]);
  });

  it("cc-06: one slot per process, on globalThis, so two copies of the package share it", () => {
    const key = Symbol.for("decocms.blocks.currentClient");
    expect(Object.getOwnPropertySymbols(globalThis)).toContain(key);
  });
});
