// @vitest-environment node
/**
 * One request on the content-addressed layout (contract §3.4): `routes()`,
 * `redirects()`, `prefetch()`, one parallel wave per request, the pin of one
 * index and its bodies, the previous-index rule, per-section failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import type { BodySource, IndexedContent } from "./contentIndex";
import { ContentUnavailableError } from "./errors";
import { matchRoute } from "./matchRoute";
import { choosePin, Pin } from "./pin";
import { docsBlocks, fakeDelivery, fakeStudio, revisionId } from "./testFixtures";
import type { Blocks } from "./types";

const SITE = "acme";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function cdn() {
  const api = fakeDelivery();
  const fetch = vi.fn(api.fetch);
  vi.stubGlobal("fetch", fetch);
  return { ...api, fetch };
}

const section = (props: unknown) => props;

function blocks(): Blocks {
  return { ...docsBlocks(), "site/sections/Text.tsx": section };
}

/** home → header, footer; footer → footer-a, footer-b; plus another page, a redirects block and an unrelated block. */
function site(title = "Hello"): Record<string, unknown> {
  return {
    // Key order is not name order: routing must not depend on it.
    zeta: { __resolveType: "page", path: "/same", sections: [] },
    home: {
      __resolveType: "page",
      path: "/",
      sections: [{ __resolveType: "header" }, { __resolveType: "footer" }],
    },
    alpha: { __resolveType: "website/pages/Page.tsx", path: "/same", sections: [] },
    header: { __resolveType: "site/sections/Text.tsx", text: title },
    footer: {
      __resolveType: "site/sections/Text.tsx",
      columns: [{ __resolveType: "footer-a" }, { __resolveType: "footer-b" }],
    },
    "footer-a": { __resolveType: "site/sections/Text.tsx", text: "a" },
    "footer-b": { __resolveType: "site/sections/Text.tsx", text: "b" },
    unrelated: { __resolveType: "site/sections/Text.tsx", text: "never fetched" },
    Redirects: {
      __resolveType: "redirects",
      redirects: [
        { from: "/old", to: "/", permanent: true },
        { redirect: { from: "/legacy", to: "/", type: "temporary" } },
        "not a rule",
      ],
    },
  };
}

/** One request through the binding flow: routes, prefetch, redirects, resolve. */
async function request(cms: ReturnType<typeof createCMS>, name = "home") {
  const c = cms.forRelease();
  await c.routes();
  c.prefetch(name);
  await c.redirects();
  return c.resolve(name);
}

const blockKey = (api: ReturnType<typeof cdn>, name: string) => `blocks/${api.hashOf(name)}.json`;

describe("routes()", () => {
  it("lists every page from the index, in code-unit order of name, with no body fetched", async () => {
    const api = cdn();
    await api.publish(site());
    const cms = createCMS({ blocks: blocks(), site: SITE });
    const [routes, error] = await cms.forRelease().routes();
    expect(error).toBeNull();
    expect(routes).toEqual([
      { name: "alpha", path: "/same" },
      { name: "home", path: "/" },
      { name: "zeta", path: "/same" },
    ]);
    expect(api.blockFetches()).toBe(0);
    // The same page wins a path conflict whatever the index's key order.
    const match = matchRoute("/same", { routes: routes ?? [] });
    expect(match.kind === "match" && match.entry.name).toBe("alpha");
  });

  it("is the same array for the same revision, and a new one after a publish", async () => {
    const api = cdn();
    await api.publish(site());
    const cms = createCMS({ blocks: blocks(), site: SITE });
    const [first] = await cms.forRelease().routes();
    const [second] = await cms.forRelease().routes();
    expect(second).toBe(first);
    await api.publish(site("Two"));
    await cms.update();
    const [third] = await cms.forRelease().routes();
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });
});

describe("one wave per request", () => {
  it("prefetch + redirects + resolve: the redirects block and the page's walk, nothing else", async () => {
    const api = cdn();
    await api.publish(site());
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await cms.forRelease().revision(); // warm the index
    const c = cms.forRelease();
    const [routes] = await c.routes();
    const page = matchRoute("/", { routes: routes ?? [] });
    expect(page.kind).toBe("match");
    if (page.kind !== "match") return;
    c.prefetch(page.entry.name);
    const [redirects] = await c.redirects();
    expect(redirects).toEqual([
      { from: "/old", to: "/", permanent: true },
      { redirect: { from: "/legacy", to: "/", type: "temporary" } },
    ]);
    expect(matchRoute("/old", { routes: [], redirects: redirects ?? [] }).kind).toBe("redirect");
    // Every block of the wave was requested before redirects() answered.
    const wave = ["Redirects", "home", "header", "footer", "footer-a", "footer-b"].map((n) =>
      blockKey(api, n),
    );
    expect(
      api
        .keys()
        .filter((k) => k.startsWith("blocks/"))
        .sort(),
    ).toEqual(wave.sort());
    const [home, error] = await c.resolve<{ sections: unknown[] }>("home");
    expect(error).toBeNull();
    expect(home?.sections).toHaveLength(2);
    expect(api.blockFetches()).toBe(6); // resolve fetched nothing more
    expect(api.keys()).not.toContain(blockKey(api, "unrelated"));
  });

  it("a warm isolate makes no block request at all", async () => {
    const api = cdn();
    await api.publish(site());
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await request(cms);
    const before = api.blockFetches();
    const c = cms.forRelease();
    c.prefetch("home");
    await c.redirects();
    await c.resolve("home");
    expect(api.blockFetches()).toBe(before);
  });

  it("a name read at run time costs one awaited fetch, then it is cached", async () => {
    const api = cdn();
    await api.publish(site());
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await cms.forRelease().resolve("home");
    expect(api.keys()).not.toContain(blockKey(api, "unrelated"));
    const [value] = await cms.forRelease().resolve<{ text: string }>("unrelated");
    expect(value?.text).toBe("never fetched");
    expect(api.keys().filter((k) => k === blockKey(api, "unrelated"))).toHaveLength(1);
    await cms.forRelease().resolve("unrelated");
    expect(api.keys().filter((k) => k === blockKey(api, "unrelated"))).toHaveLength(1);
  });

  it("an unfetchable block fails only its section: LOADER_FAILED, cause ContentUnavailableError", async () => {
    const api = cdn();
    await api.publish(site());
    api.respond(blockKey(api, "footer"), () => new Response("down", { status: 503 }));
    const cms = createCMS({ blocks: blocks(), site: SITE });
    const c = cms.forRelease();
    const [page] = await c.resolve<{ sections: unknown[] }>("home", { run: false });
    // `run: false` expands saved blocks, so the footer reference fails the whole expand…
    expect(page).toBeNull();
    // …while resolving each section on its own fails only the footer.
    const [header, headerError] = await c.resolve({ __resolveType: "header" });
    const [footer, footerError] = await c.resolve({ __resolveType: "footer" });
    expect(headerError).toBeNull();
    expect(header).toMatchObject({ text: "Hello" });
    expect(footer).toBeNull();
    expect(footerError?.code).toBe("LOADER_FAILED");
    expect(footerError?.cause).toBeInstanceOf(ContentUnavailableError);
    expect(footerError?.message).toContain('"footer"');
    // The failure is remembered for the request: no second fetch.
    await c.resolve({ __resolveType: "footer" });
    expect(api.keys().filter((k) => k === blockKey(api, "footer"))).toHaveLength(1);
  });

  it("whether a name exists comes from the pinned index, never from the cache", async () => {
    const api = cdn();
    await api.publish(site());
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await cms.forRelease().resolve("unrelated"); // its body is now cached
    const { unrelated: _gone, ...rest } = site();
    await api.publish(rest);
    await cms.update();
    const [, error] = await cms.forRelease().resolve("unrelated");
    expect(error?.code).toBe("NOT_FOUND");
  });
});

describe("the previous-index rule", () => {
  it("serves on the previous index while the new blocks load in the background, then on the new one", async () => {
    const api = cdn();
    await api.publish(site("One"));
    const cms = createCMS({ blocks: blocks(), site: SITE });
    expect((await cms.forRelease().resolve<{ text: string }>("header"))[0]?.text).toBe("One");
    await request(cms); // the old index's subtree is cached
    await api.publish(site("Two"));
    expect(await cms.update()).toEqual({ updated: true });
    const release = api.hold(blockKey(api, "header"));

    const during = cms.forRelease();
    during.prefetch("home");
    const [header] = await during.resolve<{ text: string }>({ __resolveType: "header" });
    expect(header?.text).toBe("One"); // no wait on the publish
    expect(await during.revision()).toBe(revisionId(1));
    // The new header was asked for in the background.
    await settle();
    expect(api.keys()).toContain(blockKey(api, "header"));

    release();
    await settle();
    const after = cms.forRelease();
    after.prefetch("home");
    expect((await after.resolve<{ text: string }>({ __resolveType: "header" }))[0]?.text).toBe(
      "Two",
    );
    expect(await after.revision()).toBe(revisionId(2));
  });

  it("waits for the new index when the previous one's subtree isn't cached either", async () => {
    const api = cdn();
    await api.publish(site("One"));
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await cms.forRelease().revision(); // index only
    await api.publish(site("Two"));
    await cms.update();
    const c = cms.forRelease();
    c.prefetch("home");
    expect((await c.resolve<{ text: string }>({ __resolveType: "header" }))[0]?.text).toBe("Two");
  });

  it("a draft never uses the previous index: it waits for the hashes its overlay names", async () => {
    const api = cdn();
    const studio = fakeStudio();
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/drafts/") ? studio.fetch(input, init) : api.fetch(input, init),
    );
    await api.publish(site("One"));
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await cms.forRelease().resolve("home");
    await api.publish(site("Two"));
    await cms.update();
    const pointer = studio.draft({
      set: { footer: { __resolveType: "site/sections/Text.tsx", text: "draft footer" } },
    });
    const draft = cms.forDraft(pointer);
    draft.prefetch("home");
    const [page] = await draft.resolve<{ sections: { text: string }[] }>("home");
    expect(page?.sections.map((s) => s.text)).toEqual(["Two", "draft footer"]);
    expect(await draft.revision()).toBe(`${revisionId(2)}~9f3c1a`);
  });

  it("pins the current index for a page whose path moved", () => {
    const source: BodySource = {
      peek: (h) => (h === "old" ? {} : undefined),
      get: vi.fn(async () => ({})),
    };
    const index = (version: string, path: string): IndexedContent => ({
      revision: version,
      sequence: 1,
      blocks: Object.assign(Object.create(null), {
        home: { version, meta: { type: "page", path } },
      }),
      source,
    });
    const selection = { current: index("new", "/moved"), previous: index("old", "/") };
    expect(choosePin(selection, "home").content).toBe(selection.current);
    const same = { current: index("new", "/"), previous: index("old", "/") };
    expect(choosePin(same, "home").content).toBe(same.previous);
  });
});

describe("the pin", () => {
  it("a pinned body survives LRU eviction for the rest of the request", async () => {
    const held = new Map<string, unknown>([["h1", { title: "pinned" }]]);
    const get = vi.fn(async (hash: string) => ({ title: `fetched ${hash}` }));
    const source: BodySource = { peek: (hash) => held.get(hash), get };
    const content: IndexedContent = {
      revision: "r",
      sequence: 1,
      blocks: Object.assign(Object.create(null), { a: { version: "h1" } }),
      source,
    };
    const pin = new Pin(content);
    await pin.wave(["a"]);
    held.clear(); // evicted from the LRU
    expect(await pin.body("a")).toEqual({ title: "pinned" });
    expect(get).not.toHaveBeenCalled();
  });

  it("the wave starts every missing fetch at once", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const source: BodySource = {
      peek: () => undefined,
      get: async (hash) => {
        started.push(hash);
        await gate;
        return { hash };
      },
    };
    const content: IndexedContent = {
      revision: "r",
      sequence: 1,
      blocks: Object.assign(Object.create(null), {
        a: { version: "ha" },
        b: { version: "hb" },
        c: { version: "hc" },
      }),
      source,
    };
    const wave = new Pin(content).wave(["a", "b", "c"]);
    await Promise.resolve();
    expect(started).toEqual(["ha", "hb", "hc"]);
    release();
    await wave;
  });
});

describe("list()", () => {
  it("reads entries of a type from the index, and warns once outside production for routed types", async () => {
    const api = cdn();
    await api.publish(site());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createCMS({ blocks: blocks(), site: SITE });
    const [pages] = await cms.forRelease().list<{ path: string }>("page");
    expect(pages?.map((p) => p.path)).toEqual(["/same", "/", "/same"]);
    await cms.forRelease().list("page");
    const routed = warn.mock.calls.filter(([m]) => String(m).includes('list("page")'));
    expect(routed).toHaveLength(1);
    const [texts] = await cms.forRelease().list("site/sections/Text.tsx");
    expect(texts).toHaveLength(5);
  });
});
