// @vitest-environment node
/**
 * Conformance, second pass: claims from the docs (deco-sites/docs-tanstack
 * src/content/docs/en/storefront/blocks/next) that the other conformance files test weakly or not at
 * all. Each `it` quotes the page and the claim it checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFixture } from "../../protocol/__tests__/fixtures";
import { readResponseJson } from "../../protocol/client";
import { blockFileName, blockNameFromFile } from "../../protocol/keys";
import { createContentHandler } from "../../protocol/server/handler";
import { createMemoryStorage } from "../../protocol/storage/memory";
import { instanceOf } from "../cms";
import { createInstrumentedFetch } from "../fetch";
import { createCMS, matchRoute, parseDraftPointer, resetForTests } from "../index";
import { resolveDestination, setCurrentTelemetry } from "../telemetry";
import { docsBlocks, docsSnapshot } from "../testFixtures";
import type { Blocks, Lazy, Loader, Snapshot } from "../types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setCurrentTelemetry(undefined);
  resetForTests();
});

const snap = (blocks: Record<string, unknown>, revision = "r1", extra: Partial<Snapshot> = {}) =>
  ({ revision, blocks, ...extra }) as Snapshot;

describe("matchRoute (router-internals.mdx, routing.mdx)", () => {
  it("X01 router-internals: a dead-end literal branch goes back and tries the parameter child", () => {
    const routes = [
      { name: "Deep", path: "/blog/archive/2020" },
      { name: "Post", path: "/blog/:slug" },
    ];
    const m = matchRoute("/blog/archive", { routes });
    expect(m).toEqual({ kind: "match", entry: routes[1], params: { slug: "archive" } });
  });

  it("X02 router-internals: URL is percent-decoded, query/fragment dropped, trailing slash removed; params never hold a slash", () => {
    const routes = [
      { name: "Cafe", path: "/café" },
      { name: "Product", path: "/:slug/p" },
    ];
    expect(matchRoute("https://shop.example/caf%C3%A9/?x=1#top", { routes })).toMatchObject({
      kind: "match",
      entry: { name: "Cafe" },
    });
    expect(matchRoute("/summer%20shirt/p/", { routes })).toMatchObject({
      params: { slug: "summer shirt" },
    });
    expect(matchRoute("/a%2Fb/p", { routes })).toEqual({ kind: "not-found" });
    expect(matchRoute(new Request("https://shop.example/x/p"), { routes })).toMatchObject({
      kind: "match",
      params: { slug: "x" },
    });
  });

  it("X03 routing: redirects win over a route at the same path; status wins over permanent; params fill `to`; query carried unless discarded", () => {
    const routes = [{ name: "Old", path: "/old-products/:slug" }];
    const redirects = [
      { from: "/old-products/:slug", to: "/:slug/p?ref=old", permanent: true },
      { from: "/a", to: "/b", permanent: true, status: 307 as const },
      { from: "/c", to: "/d", permanent: false, discardQueryParameters: true },
    ];
    expect(matchRoute("/old-products/summer?utm=x", { routes, redirects })).toEqual({
      kind: "redirect",
      location: "/summer/p?ref=old&utm=x",
      status: 301,
    });
    expect(matchRoute("/a", { routes, redirects })).toMatchObject({ status: 307 });
    expect(matchRoute("/c?q=1", { routes, redirects })).toEqual({
      kind: "redirect",
      location: "/d",
      status: 302,
    });
  });

  it("X04 api-reference: matchRoute never throws, whatever it's given", () => {
    const bad = [null, undefined, 42, "not a url", "http://[::1"] as unknown[];
    for (const url of bad) {
      expect(() =>
        matchRoute(url as string, { routes: [{ name: "x", path: "/" }, null as never] }),
      ).not.toThrow();
    }
    expect(() => matchRoute("/", null as never)).not.toThrow();
    expect(() =>
      matchRoute("/", { routes: [{ name: "n", path: 3 as never }], redirects: [null as never] }),
    ).not.toThrow();
  });

  it("X05 routing: two templates of one shape conflict and the earlier entry wins", () => {
    const routes = [
      { name: "A", path: "/:slug/p" },
      { name: "B", path: "/:id/p" },
    ];
    expect(matchRoute("/x/p", { routes })).toEqual({
      kind: "match",
      entry: routes[0],
      params: { slug: "x" },
    });
  });
});

describe("the lookup rule (how-resolution-works.mdx, saved-blocks.mdx, blocks.mdx)", () => {
  it("X06 saved-blocks › Names: a saved block named like a block type: the function wins, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snap({
        seo: { __resolveType: "hero", title: "saved" },
        P: { __resolveType: "seo", title: "t", description: "d" },
      }),
    });
    const [value] = await cms
      .forRelease()
      .resolve({ __resolveType: "seo", title: "a", description: "b" });
    expect(value).toEqual({ title: "a", description: "b" });
    expect(warn).toHaveBeenCalled();
  });

  it("X07 saved-blocks › Names: a saved block named like an alias: the aliased function wins, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snap(
        {
          card: { __resolveType: "hero", title: "I am a saved block" },
          Uses: { __resolveType: "card", title: "x", product: 1 },
        },
        "r1",
        { aliases: { card: "product-card" } },
      ),
    });
    const [value, error] = await cms.forRelease().resolve("Uses");
    expect(error).toBeNull();
    expect(value).toEqual({ component: "product-card", props: { title: "x", product: 1 } });
    expect(warn).toHaveBeenCalled();
  });

  it("X08 how-resolution-works: an entry referenced three times runs its function once per client; a new client runs it again", async () => {
    let runs = 0;
    const blocks: Blocks = { ...docsBlocks(), count: () => ++runs };
    const cms = createCMS({
      blocks,
      content: snap({
        Counter: { __resolveType: "count" },
        Page: {
          __resolveType: "page",
          name: "p",
          path: "/",
          sections: [
            { __resolveType: "Counter" },
            { __resolveType: "Counter" },
            { __resolveType: "Counter" },
          ],
        },
      }),
    });
    const [page] = await cms.forRelease().resolve<{ sections: number[] }>("Page");
    expect(page?.sections).toEqual([1, 1, 1]);
    expect(runs).toBe(1);
    await cms.forRelease().resolve("Page");
    expect(runs).toBe(2);
  });

  it("X09 how-resolution-works: results are returned as is; the CMS never walks a function's return value", async () => {
    const out = { __resolveType: "DoesNotExist", nested: { __resolveType: "seo" } };
    const cms = createCMS({ blocks: { ...docsBlocks(), raw: () => out }, content: snap({}) });
    const [value, error] = await cms.forRelease().resolve({ __resolveType: "raw" });
    expect(error).toBeNull();
    expect(value).toBe(out);
  });

  it("X10 how-resolution-works: an entry that references itself fails with CYCLE, the chain in error.path", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snap({
        A: { __resolveType: "B" },
        B: { __resolveType: "A" },
        Self: { __resolveType: "Self" },
      }),
    });
    const [, e1] = await cms.forRelease().resolve("A");
    expect(e1?.code).toBe("CYCLE");
    expect(e1?.path).toEqual(["A", "B", "A"]);
    const [, e2] = await cms.forRelease().resolve("Self", { run: false });
    expect(e2?.code).toBe("CYCLE");
  });

  it("X11 how-resolution-works: a failing nested block stops its parent; path says where (api-reference: ['sections', 2, 'product'])", async () => {
    const parent = vi.fn((p: unknown) => p);
    const cms = createCMS({
      blocks: {
        ...docsBlocks(),
        boom: () => {
          throw new Error("upstream down");
        },
        wrap: parent,
      },
      content: snap({}),
    });
    const [, error] = await cms.forRelease().resolve({
      __resolveType: "wrap",
      sections: [1, 2, { __resolveType: "wrap", product: { __resolveType: "boom" } }],
    });
    expect(error?.code).toBe("BLOCK_FAILED");
    expect(error?.path).toEqual(["sections", 2, "product"]);
    expect(error?.cause).toMatchObject({ message: "upstream down" });
    expect(parent).not.toHaveBeenCalled();
  });

  it("X12 how-resolution-works: a string is always a saved block's name, never a block type (NOT_FOUND)", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [, error] = await cms.forRelease().resolve("seo");
    expect(error?.code).toBe("NOT_FOUND");
    const [, e2] = await cms.forRelease().resolve("page");
    expect(e2?.code).toBe("NOT_FOUND");
  });

  it("X13 saved-blocks › Override arguments: shallow merge, then the merged block is looked up again (chained references)", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snap({
        Base: { __resolveType: "seo", title: "base", description: "base-d" },
        Mid: { __resolveType: "Base", title: "mid" },
      }),
    });
    const [value] = await cms.forRelease().resolve({ __resolveType: "Mid", description: "top" });
    expect(value).toEqual({ title: "mid", description: "top" });
    const [read] = await cms.forRelease().resolve({ __resolveType: "Mid" }, { run: false });
    expect(read).toEqual({ __resolveType: "seo", title: "mid", description: "base-d" });
  });

  it("X14 api-reference: resolve({ title: 'Store' }) returns the same object; content is never mutated by a function", async () => {
    const plain = { title: "Store", list: [1, { a: 2 }] };
    const content = snap({ S: { __resolveType: "mut", items: [1] } });
    const cms = createCMS({
      blocks: {
        mut: (p: { items: number[] }) => {
          p.items.push(2);
          return p.items.length;
        },
      },
      content,
    });
    const client = cms.forRelease();
    const [same] = await client.resolve(plain);
    expect(same).toBe(plain);
    await cms.forRelease().resolve("S");
    const [again] = await cms.forRelease().resolve("S");
    expect(again).toBe(2);
    expect((content.blocks.S as { items: number[] }).items).toEqual([1]);
  });
});

describe("built-ins (built-in-blocks.mdx, lazy-blocks.mdx, matchers-and-variants.mdx)", () => {
  it("X15 lazy-blocks: value runs only when called, at most once; a failure rejects the call and the caller handles it", async () => {
    let fetches = 0;
    const cms = createCMS({
      blocks: {
        product: () => ++fetches,
        boom: () => {
          throw new Error("nope");
        },
        card: async ({ show, product }: { show: boolean; product: Lazy<number> }) =>
          show ? [await product(), await product()] : "title only",
        safe: async ({ v }: { v: Lazy<unknown> }) => {
          try {
            return await v();
          } catch (e) {
            return `handled ${(e as { code: string }).code}`;
          }
        },
      },
      content: snap({}),
    });
    const lazyProduct = { __resolveType: "lazy", value: { __resolveType: "product" } };
    const [hidden] = await cms
      .forRelease()
      .resolve({ __resolveType: "card", show: false, product: lazyProduct });
    expect(hidden).toBe("title only");
    expect(fetches).toBe(0);
    const [shown] = await cms
      .forRelease()
      .resolve({ __resolveType: "card", show: true, product: lazyProduct });
    expect(shown).toEqual([1, 1]);
    const [handled, error] = await cms.forRelease().resolve({
      __resolveType: "safe",
      v: { __resolveType: "lazy", value: { __resolveType: "boom" } },
    });
    expect(error).toBeNull();
    expect(handled).toBe("handled BLOCK_FAILED");
  });

  it("X16 matchers-and-variants › Hide a block: a never-only block resolves to undefined, nothing inside runs, and the list leaves it out", async () => {
    const inner = vi.fn(() => "x");
    const cms = createCMS({ blocks: { ...docsBlocks(), inner }, content: snap({}) });
    const [sections, error] = await cms.forRelease().resolve([
      { __resolveType: "hero", title: "a" },
      {
        __resolveType: "multivariate",
        variants: [
          {
            rule: { __resolveType: "never" },
            value: { __resolveType: "lazy", value: { __resolveType: "inner" } },
          },
        ],
      },
      { __resolveType: "hero", title: "b" },
    ]);
    expect(error).toBeNull();
    expect(sections).toHaveLength(2);
    expect(inner).not.toHaveBeenCalled();
  });

  it("X17 matchers-and-variants: multivariate picks the first true rule; async rules are awaited; only the winner runs", async () => {
    const a = vi.fn(() => "A");
    const b = vi.fn(() => "B");
    const cms = createCMS({
      blocks: { a, b, later: async () => true },
      content: snap({}),
    });
    const [value] = await cms.forRelease().resolve({
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "never" },
          value: { __resolveType: "lazy", value: { __resolveType: "a" } },
        },
        {
          rule: { __resolveType: "later" },
          value: { __resolveType: "lazy", value: { __resolveType: "b" } },
        },
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: { __resolveType: "a" } },
        },
      ],
    });
    expect(value).toBe("B");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("X18 matchers-and-variants: date: start inclusive, end exclusive, a date without time is midnight UTC", async () => {
    vi.useFakeTimers();
    const cms = createCMS({ blocks: {}, content: snap({}) });
    const check = async (now: string, props: Record<string, string>) => {
      vi.setSystemTime(new Date(now));
      const [v] = await cms.forRelease().resolve({ __resolveType: "date", ...props });
      return v;
    };
    expect(await check("2026-11-27T00:00:00Z", { start: "2026-11-27" })).toBe(true);
    expect(await check("2026-11-26T23:59:59Z", { start: "2026-11-27" })).toBe(false);
    expect(await check("2026-12-01T05:00:00Z", { end: "2026-12-01T00:00:00-05:00" })).toBe(false);
    expect(await check("2026-12-01T04:59:59Z", { end: "2026-12-01T00:00:00-05:00" })).toBe(true);
    expect(await check("2030-01-01T00:00:00Z", {})).toBe(true);
  });

  it("X19 built-in-blocks: a built-in never fails with UNKNOWN_BLOCK (secret without key is BLOCK_FAILED); a block-map key replaces a built-in", async () => {
    const cms = createCMS({
      blocks: { page: (p: Record<string, unknown>) => ({ ...p, wrapped: true }) },
      content: snap({}),
    });
    const [, error] = await cms
      .forRelease()
      .resolve({ __resolveType: "secret", ciphertext: "v1.x" });
    expect(error?.code).toBe("BLOCK_FAILED");
    const [page] = await cms
      .forRelease()
      .resolve({ __resolveType: "page", name: "n", path: "/", sections: [] });
    expect(page).toMatchObject({ wrapped: true });
    const [settings] = await cms.forRelease().resolve<{ analytics: { collector: string } }>({
      __resolveType: "cms-settings",
    });
    expect(settings?.analytics).toMatchObject({ enabled: true });
    expect(typeof settings?.analytics.collector).toBe("string");
  });
});

describe("clients and content (api-reference.mdx, content.mdx)", () => {
  it("X20 api-reference › list: sorted by name in code-unit order; aliases match; where, sort and limit apply", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: snap(
        {
          b: { __resolveType: "post", n: 2 },
          B: { __resolveType: "post", n: 1 },
          a: { __resolveType: "old-post", n: 3 },
          X: { __resolveType: "hero", n: 9 },
        },
        "r1",
        { aliases: { "old-post": "post" } },
      ),
    });
    const [all] = await cms.forRelease().list<{ n: number }>("post");
    expect(all?.map((e) => e.n)).toEqual([1, 3, 2]);
    const [some] = await cms
      .forRelease()
      .list<{ n: number }>("post", { where: (e) => e.n > 1, sort: (x, y) => y.n - x.n, limit: 1 });
    expect(some?.map((e) => e.n)).toEqual([3]);
    const [viaAlias] = await cms.forRelease().list<{ n: number }>("old-post");
    expect(viaAlias).toHaveLength(3);
  });

  it("X21 api-reference: forRevision pins to a served revision; an unknown revision (or a draft's) behaves like the release", async () => {
    let current = docsSnapshot("rev-1");
    const loader: Loader = {
      load: async () => current,
      update: async () => ({ updated: true }),
    };
    vi.stubGlobal("fetch", async () => Response.json({ format: 1, set: {}, delete: [] }));
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    expect(await cms.forRelease().revision()).toBe("rev-1");
    const draftRevision = await cms
      .forDraft("studio.decocms.com/api/acme/decofile/store/x/changes?token=t@v1")
      .revision();
    expect(draftRevision).toBe("rev-1~v1");
    current = docsSnapshot("rev-2");
    await cms.update();
    expect(await cms.forRelease().revision()).toBe("rev-2");
    expect(await cms.forRevision("rev-1").revision()).toBe("rev-1");
    expect(await cms.forRevision("nope").revision()).toBe("rev-2");
    expect(await cms.forRevision(draftRevision).revision()).toBe("rev-2");
  });

  it("X22 api-reference › Loaders: a loader without update() is asked on every client; update() never throws", async () => {
    let n = 0;
    const cms = createCMS({
      blocks: {},
      content: { load: async () => snap({}, `r${++n}`) },
    });
    expect(await cms.forRelease().revision()).toBe("r1");
    expect(await cms.forRelease().revision()).toBe("r2");
    resetForTests();
    const throwing = createCMS({
      blocks: {},
      content: {
        load: async () => snap({}),
        update: async () => {
          throw new Error("down");
        },
      },
    });
    await expect(throwing.update()).resolves.toEqual({ updated: false });
  });

  it("X23 api-reference: interval minimum 60_000; same key with different options keeps the first instance and the warning names the options", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = snap({});
    const a = createCMS({ blocks: {}, content, interval: 1000 });
    const b = createCMS({ blocks: {}, content, interval: 120_000 });
    expect(instanceOf(b)).toBe(instanceOf(a));
    expect(warn.mock.calls.flat().join("\n")).toMatch(/interval/);
  });

  it("X24 api-reference › Draft pointers: ?__draft=off wins over the cookie; parse rejects schemes, stray @, unrooted paths", async () => {
    const req = (url: string, cookie?: string) =>
      new Request(url, { headers: cookie ? { cookie } : {} });
    const cms = createCMS({ blocks: {}, content: { revision: "x24", blocks: {} } });
    expect(
      await cms.draftPointer(req("https://s.example/?__draft=off", "deco-draft=h/p@v")),
    ).toBeNull();
    expect(await cms.draftPointer(req("https://s.example/", "deco-draft=h%2Fp%40v"))).toBe("h/p@v");
    expect(await cms.draftCookie(req("https://s.example/?__draft=off"))).toMatch(/Max-Age=0/);
    expect(await cms.draftCookie(req("https://s.example/"))).toBeNull();
    expect(parseDraftPointer("https://h.example/p@v")).toBeNull();
    expect(parseDraftPointer("h.example/p@x@v")).toBeNull();
    expect(parseDraftPointer("h.example@v")).toBeNull();
    expect(parseDraftPointer("h.example:8080/drafts/a?token=t@v1")).toEqual({
      host: "h.example:8080",
      path: "/drafts/a?token=t",
      version: "v1",
    });
  });

  it("X25 api-reference: site and token never send telemetry by themselves", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    expect(resolveDestination(undefined, "acme")).toBeNull();
  });
});

describe("the instrumented fetch (upstream-clients.mdx, telemetry.mdx)", () => {
  function recorder() {
    const histograms: { name: string; labels: Record<string, unknown> }[] = [];
    setCurrentTelemetry({
      histogram: (name: string, labels: Record<string, unknown>) =>
        histograms.push({ name, labels }),
      error: () => {},
      sampleTrace: () => false,
      span: () => {},
    } as never);
    return histograms;
  }

  it("X26 telemetry › What's sent: a retried request counts once with retries as a label; a POST is never retried", async () => {
    const histograms = recorder();
    let calls = 0;
    const f = createInstrumentedFetch({
      provider: "acme",
      fetch: (async () => new Response("", { status: ++calls < 3 ? 503 : 200 })) as typeof fetch,
      retry: { attempts: 3, backoffMs: 1 },
    });
    const res = await f("https://api.example/x", { operation: "get" });
    expect(res.status).toBe(200);
    expect(histograms).toHaveLength(1);
    expect(histograms[0]?.labels).toMatchObject({ retries: 2, status_class: "2xx", cached: false });
    calls = 0;
    const post = await f("https://api.example/x", { method: "POST", operation: "post" });
    expect(post.status).toBe(503);
    expect(calls).toBe(1);
  });

  it("X27 upstream-clients: the circuit breaker fails fast for cooldownMs after repeated failures", async () => {
    recorder();
    const inner = vi.fn(async () => new Response("", { status: 500 }));
    const f = createInstrumentedFetch({
      provider: "acme",
      fetch: inner as unknown as typeof fetch,
      circuitBreaker: { failures: 2, cooldownMs: 60_000 },
    });
    await f("https://api.example/1");
    await f("https://api.example/2");
    await expect(f("https://api.example/3")).rejects.toThrow(/circuit/);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("the content protocol (content-protocol.mdx)", () => {
  const setup = () => {
    const storage = createMemoryStorage({ state: { schema: JSON.stringify(schemaFixture) } });
    const handler = createContentHandler(storage);
    const call = async (body: unknown) => {
      const response = await handler(
        new Request("http://127.0.0.1/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: (await readResponseJson(response)) as any };
    };
    return { storage, call };
  };
  const rpc = (id: unknown, method: string, params?: unknown) => ({
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method,
    params,
  });

  it("X28 wire format: a request without an id is rejected, unknown parameters are rejected, a batch holds at most 10 calls", async () => {
    const { call } = setup();
    const noId = await call(rpc(undefined, "blocks.list", {}));
    expect(noId.body.error).toBeDefined();
    const unknown = await call(rpc(1, "blocks.list", { ifNoneMatch: "x", bogus: true }));
    expect(unknown.body.error?.code).toBe(-32602);
    const eleven = await call(Array.from({ length: 11 }, (_, i) => rpc(i, "describe")));
    const errs = Array.isArray(eleven.body)
      ? eleven.body.filter((r: any) => r.error)
      : [eleven.body];
    expect(errs.length).toBeGreaterThan(0);
    const ten = await call(Array.from({ length: 10 }, (_, i) => rpc(i, "describe")));
    expect(ten.body.every((r: any) => r.result?.protocol === "deco-content")).toBe(true);
  });

  it("X29 blocks.apply: set wins over delete; all or nothing on an invalid name; a source-extension name can't be set but can be deleted", async () => {
    const { call, storage } = setup();
    const ok = await call(
      rpc(1, "blocks.apply", { set: { A: { __resolveType: "hero" } }, delete: ["A"] }),
    );
    expect(ok.body.error).toBeUndefined();
    expect(ok.body.result.versions.A).toEqual(expect.any(String));
    const before = storage.commits;
    const bad = await call(
      rpc(2, "blocks.apply", {
        set: { B: { __resolveType: "hero" }, "x.tsx": { __resolveType: "hero" }, __proto__x: {} },
      }),
    );
    expect(bad.body.error?.code).toBe(-32003);
    expect(storage.commits).toBe(before);
    for (const name of ["__proto__", "CON", "a/../b", ""]) {
      const r = await call(rpc(3, "blocks.apply", { set: { [name]: { __resolveType: "hero" } } }));
      expect(r.body.error?.code, name).toBe(-32003);
    }
    const del = await call(rpc(4, "blocks.apply", { delete: ["x.tsx"] }));
    expect(del.body.error).toBeUndefined();
  });

  it("X30 file names: encodeURIComponent(name).json; decoded exactly once; a bad escape keeps the raw name", () => {
    expect(blockFileName("pages-Home%20Page-6f1e")).toBe("pages-Home%2520Page-6f1e.json");
    expect(blockFileName("collections/blog/posts/abc")).toBe(
      "collections%2Fblog%2Fposts%2Fabc.json",
    );
    expect(blockNameFromFile("pages-Home%2520Page-6f1e.json")).toBe("pages-Home%20Page-6f1e");
    expect(blockNameFromFile("bad%E0%A4%A.json")).toBe("bad%E0%A4%A");
  });
});

describe("telemetry settings are content (telemetry.mdx)", () => {
  it("X31 the telemetry section's rates are capped by telemetry.limits (trace default cap 0); enabled: false switches it off", async () => {
    const settings = (telemetry: Record<string, unknown>, limits?: { traceSampleRate: number }) =>
      createCMS({
        blocks: {},
        content: snap(
          { CMS: { __resolveType: "cms-settings", telemetry } },
          JSON.stringify(telemetry),
        ),
        telemetry: { endpoint: "https://otel.example", ...(limits ? { limits } : {}) },
      }).settings();
    expect((await settings({ traceSampleRate: 1 })).telemetry.traceSampleRate).toBe(0);
    expect(
      (await settings({ traceSampleRate: 1 }, { traceSampleRate: 1 })).telemetry.traceSampleRate,
    ).toBe(1);
    expect(
      (await settings({ traceSampleRate: 1, enabled: false }, { traceSampleRate: 1 })).telemetry
        .enabled,
    ).toBe(false);
  });
});
