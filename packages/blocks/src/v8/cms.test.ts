// @vitest-environment node
/**
 * createCMS (api-reference#createcms-config, content.mdx, releases-and-drafts.mdx):
 * clients, loaders, drafts, revisions, update(), and one instance per process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, instanceOf, resetForTests } from "./cms";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Loader, Snapshot } from "./types";

const POINTER = "api.deco.example/drafts/acme/main?token=abc@9f3c1a";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function draftSnapshot(): Snapshot {
  return {
    revision: "draft-9f3c1a",
    blocks: {
      SummerSEO: { __resolveType: "seo", title: "Draft title", description: "Draft" },
    },
  };
}

/** A loader serving the release and one draft, recording every call. */
function draftLoader(overrides: Partial<Loader> = {}) {
  const calls: (string | null | undefined)[] = [];
  const loader: Loader = {
    async load(pointer) {
      calls.push(pointer);
      return pointer ? draftSnapshot() : docsSnapshot();
    },
    ...overrides,
  };
  return { loader, calls };
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

  it("forDraft acts like forRelease: the content module has no drafts and ignores the pointer", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    for (const pointer of [POINTER, "not a pointer", ""]) {
      const [seo, error] = await cms.forDraft(pointer).resolve("SummerSEO");
      expect(error).toBeNull();
      expect(seo).toEqual({ title: "Sunny!", description: "Light layers for long days." });
    }
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
  it("load() with no argument is the release", async () => {
    const { loader, calls } = draftLoader();
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const [seo] = await cms.forRelease().resolve("SummerSEO");
    expect(seo).toEqual({ title: "Sunny!", description: "Light layers for long days." });
    expect(calls).toEqual([undefined]);
  });

  it("forDraft passes the pointer to load(pointer) and reads the draft", async () => {
    const { loader, calls } = draftLoader();
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const client = cms.forDraft(POINTER);
    const [seo, error] = await client.resolve("SummerSEO");
    expect(error).toBeNull();
    expect(seo).toEqual({ title: "Draft title", description: "Draft" });
    expect(calls).toEqual([POINTER]);
    expect(await client.revision()).toBe("draft-9f3c1a");
  });

  it("a draft client never mixes in published entries", async () => {
    const { loader } = draftLoader();
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const [, error] = await cms.forDraft(POINTER).resolve("HomePage");
    expect(error?.code).toBe("NOT_FOUND");
  });

  it("a failing draft makes every call on that client return [null, LOADER_FAILED]", async () => {
    const boom = new Error("403 from the draft host");
    const cms = createCMS({
      blocks: docsBlocks(),
      content: {
        async load(pointer) {
          if (pointer) throw boom;
          return docsSnapshot();
        },
      },
    });
    const client = cms.forDraft(POINTER);
    const [v1, e1] = await client.resolve("SummerSEO");
    const [v2, e2] = await client.list("page");
    const [v3, e3] = await client.resolve({ title: "literal" });
    for (const [value, error] of [
      [v1, e1],
      [v2, e2],
      [v3, e3],
    ] as const) {
      expect(value).toBeNull();
      expect(error).toMatchObject({ code: "LOADER_FAILED", cause: boom });
    }
    await expect(client.revision()).rejects.toMatchObject({ code: "LOADER_FAILED" });
    // …and the release is unaffected.
    expect((await cms.forRelease().resolve("SummerSEO"))[1]).toBeNull();
  });

  it("a pointer that doesn't parse is LOADER_FAILED, never a silent fallback to the release", async () => {
    const { loader, calls } = draftLoader();
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    for (const bad of ["https://evil.example/x@1", "no-path@1", "host/path", "", "a b/x@1"]) {
      const [value, error] = await cms.forDraft(bad).resolve("SummerSEO");
      expect(value, bad).toBeNull();
      expect(error?.code, bad).toBe("LOADER_FAILED");
    }
    expect(calls).toEqual([]);
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

  it("an update drops cached drafts, so a loader that ignores the pointer can't serve a stale release", async () => {
    let revision = "r1";
    const load = vi.fn(async () => ({ revision, blocks: { Name: revision } }));
    const cms = createCMS({
      blocks: {},
      content: { load, update: async () => ({ updated: true }) },
    });
    expect(await cms.forDraft(POINTER).resolve("Name")).toEqual(["r1", null]);
    revision = "r2";
    await cms.update();
    expect(await cms.forDraft(POINTER).resolve("Name")).toEqual(["r2", null]);
  });

  it("an update that finds nothing new keeps cached drafts", async () => {
    const { loader, calls } = draftLoader({ update: async () => ({ updated: false }) });
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    await cms.forDraft(POINTER).resolve("SummerSEO");
    await cms.update();
    await cms.forDraft(POINTER).resolve("SummerSEO");
    expect(calls).toEqual([POINTER]);
  });

  it("drafts are cached per pointer (the version is immutable)", async () => {
    const { loader, calls } = draftLoader();
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    await cms.forDraft(POINTER).resolve("SummerSEO");
    await cms.forDraft(POINTER).resolve("SummerSEO");
    expect(calls).toEqual([POINTER]);
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

  it("forRevision pins a revision this CMS has served; an unknown one behaves like the release", async () => {
    let revision = "r1";
    const cms = createCMS({
      blocks: docsBlocks(),
      content: {
        load: async () => ({ revision, blocks: { Name: revision } }),
        update: async () => ({ updated: true }),
      },
    });
    expect(await cms.forRelease().revision()).toBe("r1");
    revision = "r2";
    await cms.update();
    expect(await cms.forRelease().revision()).toBe("r2");
    expect(await cms.forRevision("r1").resolve("Name")).toEqual(["r1", null]);
    expect(await cms.forRevision("never-served").revision()).toBe("r2");
  });

  it("forRevision never reaches a draft: a draft revision behaves like the release", async () => {
    const { loader } = draftLoader();
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    expect(await cms.forDraft(POINTER).revision()).toBe("draft-9f3c1a");
    const client = cms.forRevision("draft-9f3c1a");
    expect(await client.revision()).toBe("rev-1");
    expect(await client.resolve("SummerSEO")).toEqual([
      { title: "Sunny!", description: "Light layers for long days." },
      null,
    ]);
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

  it("reads DECO_CONTENT_INTERVAL when interval is left out", async () => {
    vi.stubEnv("DECO_CONTENT_INTERVAL", "300000");
    const { cms, update, at } = scheduled();
    at("2026-10-03T00:00:00Z");
    cms.forRelease();
    await idle();
    at("2026-10-03T00:04:59Z");
    cms.forRelease();
    await idle();
    expect(update).toHaveBeenCalledTimes(1);
    at("2026-10-03T00:05:00Z");
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
    expect(await app.forRevision("r1").resolve("Hero")).toEqual(["app", null]);
    expect(await app.forDraft("anything").resolve("Hero")).toEqual(["app", null]);
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
    expect(await cms.forRevision("r1").resolve("Home")).toEqual(["after", null]);
  });

  it("a loader you write is identified by the loader object", () => {
    const one = draftLoader().loader;
    const two = draftLoader().loader;
    expect(instanceOf(createCMS({ blocks: {}, content: one }))).toBe(
      instanceOf(createCMS({ blocks: {}, content: one })),
    );
    expect(instanceOf(createCMS({ blocks: {}, content: one }))).not.toBe(
      instanceOf(createCMS({ blocks: {}, content: two })),
    );
  });

  it("with the hosted Deco CMS, the site ID and token are part of the key", () => {
    const content = docsSnapshot();
    const a = createCMS({ blocks: {}, content, site: "acme", token: "t1" });
    expect(instanceOf(createCMS({ blocks: {}, content, site: "acme", token: "t1" }))).toBe(
      instanceOf(a),
    );
    expect(instanceOf(createCMS({ blocks: {}, content, site: "other", token: "t1" }))).not.toBe(
      instanceOf(a),
    );
    expect(instanceOf(createCMS({ blocks: {}, content, site: "acme", token: "t2" }))).not.toBe(
      instanceOf(a),
    );
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
