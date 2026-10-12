// @vitest-environment node
/**
 * createCMS (api-reference#createcms-config, content.mdx, releases-and-drafts.mdx):
 * clients, loaders, drafts, revisions, update(), and one instance per process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, instanceOf, resetForTests } from "./cms";
import { docsBlocks, docsSnapshot, fakeStudio } from "./testFixtures";
import type { Loader, Snapshot } from "./types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const DRAFT_SEO = { __resolveType: "seo", title: "Draft title", description: "Draft" };

/** A fake Studio with one saved draft: its pointer, and the fetch the CMS makes. */
function studioDraft() {
  const studio = fakeStudio();
  const fetch = vi.fn(studio.fetch);
  vi.stubGlobal("fetch", fetch);
  const pointer = studio.draft({ set: { SummerSEO: DRAFT_SEO }, delete: ["HelloWorld"] });
  return { studio, fetch, pointer };
}

/** A loader recording every load. */
function countingLoader(overrides: Partial<Loader> = {}) {
  let loads = 0;
  const loader: Loader = {
    async load() {
      loads++;
      return docsSnapshot();
    },
    ...overrides,
  };
  return { loader, loads: () => loads };
}

describe("createCMS with the content module", () => {
  it("forRelease reads the content module (the content.mdx example)", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const client = cms.forRelease();
    const [page, error] = await client.resolve("HomePage");
    expect(error).toBeNull();
    expect(page).toMatchObject({ name: "Home", path: "/" });
    expect(await client.revision()).toBe("rev-1");
  });

  it("forDraft layers the draft's changes over the content module, with no site or token", async () => {
    const { pointer } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const draft = cms.forDraft(pointer);
    expect(await draft.resolve("SummerSEO")).toEqual([
      { title: "Draft title", description: "Draft" },
      null,
    ]);
    expect((await draft.resolve("HelloWorld"))[1]?.code).toBe("NOT_FOUND");
    expect((await draft.resolve("HomePage"))[1]).toBeNull(); // inherited
  });

  it("update() reports nothing new: a snapshot never changes", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    await expect(cms.update()).resolves.toEqual({ updated: false });
  });

  it("rejects a config that isn't one, at module scope", () => {
    expect(() => createCMS(null as never)).toThrow(TypeError);
    expect(() => createCMS({ blocks: null as never, content: docsSnapshot() })).toThrow(/blocks/);
    expect(() => createCMS({ blocks: {}, content: { blocks: {} } as never })).toThrow(/content/);
    expect(() => createCMS({ blocks: {}, content: 42 as never })).toThrow(/content/);
  });
});

describe("loaders", () => {
  it("load() is the release; a draft is layered over what it returned", async () => {
    const { pointer } = studioDraft();
    const { loader, loads } = countingLoader();
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const [seo] = await cms.forRelease().resolve("SummerSEO");
    expect(seo).toEqual({ title: "Sunny!", description: "Light layers for long days." });
    const client = cms.forDraft(pointer);
    expect((await client.resolve("SummerSEO"))[0]).toEqual({
      title: "Draft title",
      description: "Draft",
    });
    expect(await client.revision()).toBe('rev-1~"etag-1"'); // the draft body's ETag names the view
    expect(loads()).toBe(2); // a loader without update() is asked per client
  });

  it("a failing draft makes every call on that client return [null, LOADER_FAILED]", async () => {
    const { studio, pointer } = studioDraft();
    studio.respond("summer-sale", () => new Response("down", { status: 502 }));
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const client = cms.forDraft(pointer);
    const [v1, e1] = await client.resolve("SummerSEO");
    const [v2, e2] = await client.list("page");
    const [v3, e3] = await client.resolve({ title: "literal" });
    for (const [value, error] of [
      [v1, e1],
      [v2, e2],
      [v3, e3],
    ] as const) {
      expect(value).toBeNull();
      expect(error).toMatchObject({ code: "LOADER_FAILED" });
      expect(String((error?.cause as Error)?.message)).toContain("HTTP 502");
    }
    await expect(client.revision()).rejects.toMatchObject({ code: "LOADER_FAILED" });
    // …and the release is unaffected.
    expect((await cms.forRelease().resolve("SummerSEO"))[1]).toBeNull();
  });

  it("a pointer that doesn't parse is LOADER_FAILED, never a silent fallback to the release", async () => {
    const { fetch } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    for (const bad of ["https://evil.example/x@1", "no-path@1", "host/path", "", "a b/x@1"]) {
      const [value, error] = await cms.forDraft(bad).resolve("SummerSEO");
      expect(value, bad).toBeNull();
      expect(error?.code, bad).toBe("LOADER_FAILED");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a loader that returns something other than a snapshot is LOADER_FAILED", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { load: async () => ({ blocks: {} }) as never },
    });
    expect((await cms.forRelease().resolve("x"))[1]?.code).toBe("LOADER_FAILED");
  });

  it("a failing release load is an error, and the next client tries again", async () => {
    let fail = true;
    const loader: Loader = {
      async load() {
        if (fail) throw new Error("storage down");
        return docsSnapshot();
      },
      update: async () => ({ updated: false }),
    };
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    expect((await cms.forRelease().resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
    fail = false;
    expect((await cms.forRelease().resolve("SummerSEO"))[1]).toBeNull();
  });

  it("a loader without update() is asked on every new client (always current)", async () => {
    let revision = 1;
    const load = vi.fn(async () => ({ ...docsSnapshot(), revision: `r${revision}` }));
    const cms = createCMS({ blocks: docsBlocks(), content: { load } });
    const first = cms.forRelease();
    expect(await first.revision()).toBe("r1");
    revision = 2;
    expect(await cms.forRelease().revision()).toBe("r2");
    expect(await first.revision()).toBe("r1");
  });

  it("a loader with update() is loaded once, shared by every client, and reloaded after an update", async () => {
    let revision = 1;
    let changed = false;
    const load = vi.fn(async () => ({ ...docsSnapshot(), revision: `r${revision}` }));
    const update = vi.fn(async () => ({ updated: changed }));
    const cms = createCMS({ blocks: docsBlocks(), content: { load, update } });

    expect(await cms.forRelease().revision()).toBe("r1");
    expect(await cms.forRelease().revision()).toBe("r1");
    expect(load).toHaveBeenCalledTimes(1);

    revision = 2;
    expect(await cms.update()).toEqual({ updated: false });
    expect(await cms.forRelease().revision()).toBe("r1");

    changed = true;
    expect(await cms.update()).toEqual({ updated: true });
    expect(await cms.forRelease().revision()).toBe("r2");
  });

  it("update() never throws and shares one check between concurrent callers", async () => {
    const update = vi.fn(async () => {
      throw new Error("network");
    });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { load: async () => docsSnapshot(), update },
    });
    const results = await Promise.all([cms.update(), cms.update()]);
    expect(results).toEqual([{ updated: false }, { updated: false }]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("an update drops fetched drafts, and the next draft client follows the new release", async () => {
    const { fetch, pointer } = studioDraft();
    let revision = "r1";
    const cms = createCMS({
      blocks: {},
      content: {
        load: async () => ({ revision, blocks: { Name: revision } }),
        update: async () => ({ updated: true }),
      },
    });
    expect(await cms.forDraft(pointer).resolve("Name")).toEqual(["r1", null]);
    revision = "r2";
    await cms.update();
    expect(await cms.forDraft(pointer).resolve("Name")).toEqual(["r2", null]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("an update that finds nothing new keeps the fetched draft body: the next read revalidates it", async () => {
    const { fetch, pointer } = studioDraft();
    const { loader } = countingLoader({ update: async () => ({ updated: false }) });
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    await cms.forDraft(pointer).resolve("SummerSEO");
    await cms.update();
    await cms.forDraft(pointer).resolve("SummerSEO");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe('"etag-1"');
    expect((await fetch.mock.results[1]?.value)?.status).toBe(304);
  });

  it("every draft read revalidates: a 304 reuses the body, a new save is read again", async () => {
    const { studio, fetch, pointer } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const first = cms.forDraft(pointer);
    await first.resolve("SummerSEO");
    const second = cms.forDraft(pointer);
    expect((await second.resolve("SummerSEO"))[0]).toMatchObject({ title: "Draft title" });
    expect(await second.revision()).toBe(await first.revision());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("if-none-match")).toBeNull();
    expect((await fetch.mock.results[1]?.value)?.status).toBe(304);

    studio.draft({ set: { SummerSEO: { ...DRAFT_SEO, title: "Saved again" } } });
    const third = cms.forDraft(pointer); // the same pointer outlives the save
    expect((await third.resolve("SummerSEO"))[0]).toMatchObject({ title: "Saved again" });
    expect(await third.revision()).toBe('rev-1~"etag-2"');
  });

  it("concurrent reads of one draft share one request", async () => {
    const { fetch, pointer } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    await Promise.all([
      cms.forDraft(pointer).resolve("SummerSEO"),
      cms.forDraft(pointer).resolve("SummerSEO"),
      cms.forDraft(pointer).resolve("HomePage"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("one revision per client", () => {
  it("a client keeps reading the revision it loaded, even after an update", async () => {
    let revision = "r1";
    const cms = createCMS({
      blocks: docsBlocks(),
      content: {
        load: async () => ({ revision, blocks: { Name: revision } }),
        update: async () => ({ updated: true }),
      },
    });
    const client = cms.forRelease();
    expect(await client.resolve("Name")).toEqual(["r1", null]);
    revision = "r2";
    await cms.update();
    expect(await client.resolve("Name")).toEqual(["r1", null]);
    expect(await client.list("anything")).toEqual([[], null]);
    expect(await client.revision()).toBe("r1");
    expect(await cms.forRelease().resolve("Name")).toEqual(["r2", null]);
  });

  it("a client loads its content once, lazily, on first use", async () => {
    const load = vi.fn(async () => docsSnapshot());
    const cms = createCMS({ blocks: docsBlocks(), content: { load } });
    const client = cms.forRelease();
    expect(load).not.toHaveBeenCalled();
    await Promise.all([client.resolve("SummerSEO"), client.list("page"), client.revision()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("update() checks on an interval", () => {
  // Background work goes through the host hook, deferred to a timer so a
  // request never runs it; `idle` waits for exactly what was scheduled (a
  // fixed sleep could return first on a loaded machine and read a count short).
  const HOOK = Symbol.for("decocms.blocks.background");
  const g = globalThis as { [HOOK]?: (task: () => Promise<void>) => void };
  let background: Promise<void>[] = [];
  beforeEach(() => {
    background = [];
    g[HOOK] = (task) => {
      background.push(new Promise((resolve) => setTimeout(resolve, 0)).then(task));
    };
  });
  afterEach(() => {
    delete g[HOOK];
  });
  const idle = () => Promise.all(background.splice(0));

  /** A CMS over a loader with update(), with the clock and the jitter under test control. */
  function scheduled(interval?: number, random = 0.5) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(Math, "random").mockReturnValue(random); // 0.5: no jitter
    vi.setSystemTime(0); // module scope on Workers
    const update = vi.fn(async () => ({ updated: false }));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { load: async () => docsSnapshot(), update },
      interval,
    });
    return { cms, update, at: (iso: string) => vi.setSystemTime(new Date(iso)) };
  }

  it("checks on first use, then every interval, in the background (never in front of a request)", async () => {
    const { cms, update, at } = scheduled(120_000);
    at("2026-10-03T00:00:00Z");
    cms.forRelease();
    expect(update).not.toHaveBeenCalled(); // scheduled, not awaited by the request
    await idle();
    expect(update).toHaveBeenCalledTimes(1);

    at("2026-10-03T00:01:59Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(1);

    at("2026-10-03T00:02:00Z");
    cms.forRelease();
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("starts the clock on the first forRelease, not at module scope (Workers read Date.now() as 0 there)", async () => {
    const { cms, update, at } = scheduled();
    at("2026-10-03T00:00:00Z");
    cms.forRelease();
    await idle();
    at("2026-10-03T00:00:59Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(1);
    at("2026-10-03T00:01:00Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("never checks more often than every 60 000 ms, and warns when it raises interval", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { cms, update, at } = scheduled(1_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("raised to 60000 ms"));
    at("2026-10-03T00:00:00Z");
    cms.forRelease();
    await idle();
    at("2026-10-03T00:00:30Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(1);
    at("2026-10-03T00:01:00Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("spreads checks by up to 10 s either way, so servers that started together don't check together", async () => {
    const early = scheduled(undefined, 0); // -10 s
    early.at("2026-10-03T00:00:00Z");
    early.cms.forRelease();
    await idle();
    early.at("2026-10-03T00:00:50Z");
    early.cms.forRelease();
    await idle();
    expect(early.update).toHaveBeenCalledTimes(2);

    resetForTests();
    const late = scheduled(undefined, 1); // +10 s
    late.at("2026-10-03T00:00:00Z");
    late.cms.forRelease();
    await idle();
    late.at("2026-10-03T00:01:09Z");
    late.cms.forRelease();
    await idle();
    expect(late.update).toHaveBeenCalledTimes(1);
    late.at("2026-10-03T00:01:10Z");
    late.cms.forRelease();
    await idle();
    expect(late.update).toHaveBeenCalledTimes(2);
  });

  it("cms.update() checks at once and restarts the clock", async () => {
    const { cms, update, at } = scheduled();
    at("2026-10-03T00:00:00Z");
    await cms.update();
    expect(update).toHaveBeenCalledTimes(1);
    at("2026-10-03T00:00:59Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("reads no DECO_CONTENT_INTERVAL: left out, the interval is the 60 s minimum", async () => {
    vi.stubEnv("DECO_CONTENT_INTERVAL", "300000");
    const { cms, update, at } = scheduled();
    at("2026-10-03T00:00:00Z");
    cms.forRelease();
    await idle();
    at("2026-10-03T00:01:11Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("one instance per process", () => {
  it("two calls on one content root share the content but each resolves with its own block map", async () => {
    // Next runs the proxy bundle in the app's process: its createCMS must not replace the app's map.
    const content = { revision: "r1", root: ".deco", blocks: { Hero: { __resolveType: "hero" } } };
    const app = createCMS({ blocks: { hero: () => "app" }, content });
    const proxy = createCMS({ blocks: { hero: () => "proxy" }, content });
    expect(instanceOf(proxy)).toBe(instanceOf(app));
    expect(await app.forRelease().resolve("Hero")).toEqual(["app", null]);
    expect(await proxy.forRelease().resolve("Hero")).toEqual(["proxy", null]);
    expect(await app.forDraft("localhost:4547/@local").resolve("Hero")).toEqual(["app", null]);
    // Still one store: an update through either is seen by both.
    createCMS({
      blocks: { hero: () => "proxy" },
      content: { revision: "r2", root: ".deco", blocks: content.blocks },
    });
    expect(await app.forRelease().revision()).toBe("r2");
  });

  it("the same config returns the same instance", () => {
    const blocks = docsBlocks();
    const content = docsSnapshot();
    expect(instanceOf(createCMS({ blocks, content }))).toBe(
      instanceOf(createCMS({ blocks, content })),
    );
  });

  it("is keyed by the content's identity, never its revision (a hot reload keeps the instance and serves the new content)", async () => {
    const first = createCMS({
      blocks: docsBlocks(),
      content: { ...docsSnapshot("rev-1"), root: ".deco" },
    });
    const next = { ...docsSnapshot("rev-2"), root: ".deco" };
    (next.blocks.SummerSEO as Record<string, unknown>).title = "Reloaded";
    const second = createCMS({ blocks: docsBlocks(), content: next });
    expect(instanceOf(second)).toBe(instanceOf(first));
    expect(await first.forRelease().revision()).toBe("rev-2");
    expect((await first.forRelease().resolve<{ title: string }>("SummerSEO"))[0]?.title).toBe(
      "Reloaded",
    );
  });

  it("different content modules (several sites in one app) get different instances", () => {
    const a = createCMS({
      blocks: docsBlocks(),
      content: { ...docsSnapshot(), root: "sites/a/.deco" } as Snapshot,
    });
    const b = createCMS({
      blocks: docsBlocks(),
      content: { ...docsSnapshot(), root: "sites/b/.deco" } as Snapshot,
    });
    expect(instanceOf(a)).not.toBe(instanceOf(b));
  });

  it("two content modules without a root never share an instance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const modA: Snapshot = { revision: "same", blocks: { Home: "A" } };
    const modB: Snapshot = { revision: "same", blocks: { Home: "B" } };
    const a = createCMS({ blocks: {}, content: modA });
    const b = createCMS({ blocks: {}, content: modB });
    expect(instanceOf(a)).not.toBe(instanceOf(b));
    expect(await a.forRelease().resolve("Home")).toEqual(["A", null]);
    expect(await b.forRelease().resolve("Home")).toEqual(["B", null]);
    expect(instanceOf(createCMS({ blocks: {}, content: modA }))).toBe(instanceOf(a));
    expect(warn).not.toHaveBeenCalled();
  });

  it("a hot reload with the same revision still serves the edited content", async () => {
    // An edited JSON file reloads without rerunning `deco content`: new blocks, old revision.
    const cms = createCMS({
      blocks: {},
      content: { revision: "r1", root: ".deco", blocks: { Home: "before" } },
    });
    expect(await cms.forRelease().resolve("Home")).toEqual(["before", null]);
    createCMS({
      blocks: {},
      content: { revision: "r1", root: ".deco", blocks: { Home: "after" } },
    });
    expect(await cms.forRelease().resolve("Home")).toEqual(["after", null]);
  });

  it("a loader you write is identified by the loader object", () => {
    const one = countingLoader().loader;
    const two = countingLoader().loader;
    expect(instanceOf(createCMS({ blocks: {}, content: one }))).toBe(
      instanceOf(createCMS({ blocks: {}, content: one })),
    );
    expect(instanceOf(createCMS({ blocks: {}, content: one }))).not.toBe(
      instanceOf(createCMS({ blocks: {}, content: two })),
    );
  });

  it("with hosted releases, the site ID is part of the key; the token isn't (another one warns)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = docsSnapshot();
    const a = createCMS({ blocks: {}, content, site: "acme", token: "t1" });
    expect(instanceOf(createCMS({ blocks: {}, content, site: "acme", token: "t1" }))).toBe(
      instanceOf(a),
    );
    expect(instanceOf(createCMS({ blocks: {}, content, site: "other", token: "t1" }))).not.toBe(
      instanceOf(a),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(instanceOf(createCMS({ blocks: {}, content, site: "acme", token: "t2" }))).toBe(
      instanceOf(a),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(token)"));
    expect(instanceOf(createCMS({ blocks: {}, content }))).not.toBe(instanceOf(a));
  });

  it("never puts the token in the global symbol registry", () => {
    createCMS({ blocks: {}, content: docsSnapshot(), site: "acme", token: "super-secret-token" });
    const keys = Object.getOwnPropertySymbols(globalThis).map((s) => Symbol.keyFor(s) ?? "");
    expect(keys.some((k) => k.startsWith("decocms.blocks.cms:"))).toBe(true);
    expect(keys.some((k) => k.includes("super-secret-token"))).toBe(false);
  });

  it("same key, different options: keeps the first instance and warns, naming the options", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = docsSnapshot();
    const first = createCMS({ blocks: {}, content, interval: 60_000 });
    const second = createCMS({
      blocks: {},
      content,
      interval: 120_000,
      telemetry: { endpoint: "https://otel.example.com" },
    });
    expect(instanceOf(second)).toBe(instanceOf(first));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("interval");
    expect(warn.mock.calls[0]?.[0]).toContain("telemetry");
    expect(warn.mock.calls[0]?.[0]).not.toContain("secrets");
  });

  it("the warning never prints a secret", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = docsSnapshot();
    createCMS({ blocks: {}, content, secrets: { key: "PEM-ONE" } });
    createCMS({ blocks: {}, content, secrets: { key: "PEM-TWO" } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("secrets");
    expect(warn.mock.calls[0]?.[0]).not.toContain("PEM");
  });

  it("equal options in a different key order don't warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = docsSnapshot();
    createCMS({ blocks: {}, content, telemetry: { endpoint: "e", headers: { a: "1", b: "2" } } });
    createCMS({ blocks: {}, content, telemetry: { headers: { b: "2", a: "1" }, endpoint: "e" } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("instances live on globalThis under a Symbol.for key", () => {
    const cms = createCMS({ blocks: {}, content: docsSnapshot() });
    const symbols = Object.getOwnPropertySymbols(globalThis).filter((s) =>
      Symbol.keyFor(s)?.startsWith("decocms.blocks.cms:"),
    );
    expect(symbols).toHaveLength(1);
    expect((globalThis as unknown as Record<symbol, unknown>)[symbols[0]!]).toBe(instanceOf(cms));
  });

  it("an instance an older copy of the package stored (no handles) is replaced, not adopted", async () => {
    const content = { revision: "r1", root: ".deco-old", blocks: { Home: "home" } };
    createCMS({ blocks: {}, content });
    const key = Object.getOwnPropertySymbols(globalThis).find((s) =>
      Symbol.keyFor(s)?.startsWith("decocms.blocks.cms:"),
    )!;
    const store = globalThis as unknown as Record<symbol, unknown>;
    store[key] = { adopt: () => {}, fingerprint: {} };
    const cms = createCMS({ blocks: {}, content });
    expect(await cms.forRelease().resolve("Home")).toEqual(["home", null]);
    expect(store[key]).toBe(instanceOf(cms));
  });

  it("resetForTests clears every stored instance", () => {
    const content = docsSnapshot();
    const first = createCMS({ blocks: {}, content });
    resetForTests();
    expect(instanceOf(createCMS({ blocks: {}, content }))).not.toBe(instanceOf(first));
    expect(
      Object.getOwnPropertySymbols(globalThis).filter((s) =>
        Symbol.keyFor(s)?.startsWith("decocms.blocks.cms:"),
      ),
    ).toHaveLength(1);
  });

  it("the content cache is shared: clients are cheap", async () => {
    const load = vi.fn(async () => docsSnapshot());
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { load, update: async () => ({ updated: false }) },
    });
    await Promise.all(Array.from({ length: 10 }, () => cms.forRelease().resolve("SummerSEO")));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("preview.draftHosts", () => {
  it("replaces the default draft hosts a draft pointer's host must fall under", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ set: {}, delete: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    const pointer = "drafts.example.com/sites/acme/drafts/x.json@1";
    const defaults = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect((await defaults.forDraft(pointer).resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
    expect(fetch).not.toHaveBeenCalled();
    resetForTests();
    const own = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { draftHosts: [" Drafts.Example.com "] },
    });
    expect((await own.forDraft(pointer).resolve("SummerSEO"))[1]).toBeNull();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://drafts.example.com/sites/acme/drafts/x.json?v=1",
    );
    const studio = "delivery.decocms.com/sites/acme/drafts/x.json@1";
    expect((await own.forDraft(studio).resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
  });

  it("reads no DECO_PREVIEW_API_DOMAINS", async () => {
    vi.stubEnv("DECO_PREVIEW_API_DOMAINS", "drafts.example.com");
    const fetch = vi.fn(async () => Response.json({ set: {}, delete: [] }));
    vi.stubGlobal("fetch", fetch);
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [, error] = await cms.forDraft("drafts.example.com/x.json@1").resolve("SummerSEO");
    expect(error?.code).toBe("LOADER_FAILED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws a TypeError at createCMS on anything but a list of hosts", () => {
    for (const draftHosts of ["a.example", [""], [1], null]) {
      expect(() =>
        createCMS({
          blocks: {},
          content: docsSnapshot(),
          preview: { draftHosts: draftHosts as never },
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("site and token", () => {
  it("token without site throws a configuration error", () => {
    expect(() => createCMS({ blocks: {}, content: docsSnapshot(), token: "tok" })).toThrow(
      new TypeError("createCMS: token needs site: pass both, or site alone"),
    );
  });

  it("accepts site with token, site alone, or neither", () => {
    expect(() =>
      createCMS({ blocks: {}, content: docsSnapshot(), site: "acme", token: "tok" }),
    ).not.toThrow();
    resetForTests();
    expect(() => createCMS({ blocks: {}, content: docsSnapshot(), site: "acme" })).not.toThrow();
    resetForTests();
    expect(() => createCMS({ blocks: {}, content: docsSnapshot() })).not.toThrow();
  });
});
