// @vitest-environment node
/**
 * The section runner and the mixins against v7's own code
 * (`src/__fixtures__/v7`): latest 7.x cms/sectionLoaders.ts and
 * cms/sectionMixins.ts, and 7.77.12's cms/sectionLoaders.ts for
 * `nested: "direct"`. v7 is driven the way its TanStack page route drove it:
 * loaders registered with `registerSectionLoaders`, `runSectionLoaders` over
 * the page's sections with `new Request(pageUrl, { headers })`, and the
 * degraded sections read back with `getDegradedSections()`.
 *
 * The one shape difference is the nested section's key: v7's resolver wrote
 * `{ Component, props }`, v8's section blocks write `{ component, props }`.
 * Each case is generated once and written in each world's shape, and v7's
 * output is read back into v8's before comparing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v7Loader } from "../__tests__/loadV7";
import { pick, rng } from "../__tests__/v7";
import {
  compose,
  runSectionLoader,
  runSectionLoaders,
  type Section,
  type SectionLoaderFn,
  withDevice,
  withMobile,
  withSearchParam,
  withSectionLoader,
} from "./index.ts";

// ---------------------------------------------------------------------------
// v7, loaded from the reference files
// ---------------------------------------------------------------------------

/** v7's request-scoped bag (RequestContext.getBag/setBag), one per page run. */
let bag = new Map<string, unknown>();
const V7_CTX = Object.freeze({ v7: "ctx" });

function stubs(prefix: string) {
  const store = () => {
    const m = new Map<string, unknown>();
    return {
      key: (k: string) => k,
      get: (k: string) => m.get(k),
      read: async (k: string) => m.get(k),
      set: (k: string, v: unknown) => m.set(k, v),
      delete: (k: string) => m.delete(k),
    };
  };
  return {
    "@decocms/blocks/sdk/requestContext": {
      RequestContext: {
        getBag: (k: string) => bag.get(k),
        setBag: (k: string, v: unknown) => bag.set(k, v),
      },
    },
    [`${prefix}sdk/cacheHeaders`]: { getCacheProfile: () => ({ loader: { fresh: 60_000 } }) },
    [`${prefix}sdk/cacheStorage`]: {
      createCacheStore: store,
      cacheBackground: () => {},
      getCacheStorageContext: () => undefined,
    },
    [`${prefix}sdk/inflightTimeout`]: { withInflightTimeout: (p: Promise<unknown>) => p },
    [`${prefix}sdk/observability`]: {
      withTracing: (_: string, fn: () => unknown) => fn(),
    },
    [`${prefix}cms/sectionLoaderContext`]: { buildSectionLoaderContext: () => V7_CTX },
  };
}

const latest = v7Loader({ stubs: stubs("") });
const v7Loaders = latest("cms/sectionLoaders.ts");
const v7Mixins = latest("cms/sectionMixins.ts");
const v7Direct = v7Loader({
  stubs: { ...stubs("v7.77.12/"), "v7.77.12/sdk/detectDevice": latest("sdk/detectDevice.ts") },
})("v7.77.12/cms/sectionLoaders.ts");

// v7's registries live on globalThis.__deco (shared by both reference copies).
const deco = (globalThis as any).__deco as {
  sectionLoaderRegistry: Map<string, unknown>;
  nonCriticalSections: Set<string>;
  layoutSections: Set<string>;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Cases: written once, in each world's shape
// ---------------------------------------------------------------------------

type World = "v7" | "v8";
const KEY: Record<World, string> = { v7: "Component", v8: "component" };

/** Rename every nested section's key, keeping shared subtrees shared and cycles cyclic. */
function rekey(
  value: unknown,
  from: string,
  to: string,
  seen = new Map<object, unknown>(),
): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(rekey(item, from, to, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = Object.create(proto);
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k === from ? to : k] = rekey(v, from, to, seen);
  return out;
}

const UAS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "",
];
const QUERIES = [
  "",
  "?q=shoe",
  "?a=1&q=caf%C3%A9",
  "?q=a+b",
  "?q=%E0%A4%A",
  "?q=",
  "?x=1",
  "?qq=1&q=2&q=3",
];
const PATHS = ["/", "/s", "/categoria/t%C3%AAnis", "/p/123/p", "/a/b/c"];

/** A loader by kind; `mk` writes a section in the world's shape. */
function makeLoader(
  kind: string,
  world: World,
  mixins: typeof v7Mixins,
): SectionLoaderFn | undefined {
  const mk = (component: string, props: Record<string, unknown>) => ({
    [KEY[world]]: component,
    props,
  });
  switch (kind) {
    case "add":
      return (props, req) => ({
        ...props,
        seen: [props.__pageUrl, props.__pagePath, req.url, req.method],
      });
    case "async":
      return async (props) => {
        await Promise.resolve();
        await null;
        return { ...props, async: true };
      };
    case "throw":
      return () => {
        throw new Error("upstream down");
      };
    case "reject":
      return async () => {
        await Promise.resolve();
        throw new Error("upstream down");
      };
    case "spawn":
      // A spawned section that spawns again returns its props (no endless tree).
      return (props) =>
        props.from === "spawn"
          ? props
          : {
              ...props,
              spawned: mk("site/sections/Leaf.tsx", { from: "spawn" }),
              spawnedList: [
                1,
                mk("site/sections/Thrower.tsx", { from: "spawn" }),
                { deep: mk("site/sections/Adder.tsx", { from: "spawn" }) },
              ],
            };
    case "replace":
      return () => ({ replaced: true });
    case "nothing":
      return () => undefined as never;
    case "device":
      return mixins.withDevice();
    case "mobile":
      return mixins.withMobile();
    case "search":
      return mixins.withSearchParam();
    case "composed":
      return mixins.compose(mixins.withDevice(), mixins.withSearchParam(), mixins.withMobile());
    case "module":
      return mixins.compose(
        mixins.withMobile(),
        mixins.withSectionLoader(async () => ({
          loader: (props: Record<string, unknown>) => ({ ...props, fromModule: props.isMobile }),
        })),
      );
    default:
      return undefined;
  }
}

const KINDS = [
  "none",
  "add",
  "async",
  "throw",
  "reject",
  "spawn",
  "replace",
  "nothing",
  "device",
  "mobile",
  "search",
  "composed",
  "module",
];
const COMPONENTS = [
  "site/sections/Shelf.tsx",
  "site/sections/Banner.tsx",
  "site/sections/Wrapper.tsx",
  "site/sections/Tabs.tsx",
  "site/sections/Header/Header.tsx",
  "site/sections/Footer.tsx",
  "site/sections/Leaf.tsx",
  "site/sections/Thrower.tsx",
  "site/sections/Adder.tsx",
  "constructor",
];

interface Case {
  loaders: Record<string, string>;
  nonCritical: string[];
  /** Page sections in v8's shape (v7's top level used lowercase `component` too). */
  sections: Section[];
  pageUrl: string;
  ua: string;
  /** Send the request as a server-function call, with the page in `url`. */
  serverFn: boolean;
}

function genCase(r: () => number): Case {
  const loaders: Record<string, string> = {};
  for (const c of COMPONENTS) loaders[c] = pick(r, KINDS);
  loaders["site/sections/Thrower.tsx"] = r() < 0.7 ? "throw" : loaders["site/sections/Thrower.tsx"];
  const nonCritical = COMPONENTS.filter(() => r() < 0.2);

  const shared: unknown[] = [];
  const value = (depth: number): unknown => {
    const x = r();
    if (depth > 4 || x < 0.25) return pick(r, [1, "s", null, true, undefined, 0]);
    if (x < 0.45) return section(depth + 1);
    if (x < 0.6) return Array.from({ length: Math.floor(r() * 4) }, () => value(depth + 1));
    if (x < 0.72) return object(depth + 1);
    if (x < 0.77)
      return pick(r, [
        { component: "decoy", props: [1] },
        { component: pick(r, COMPONENTS), props: [object(depth + 1)] },
        { component: 7, props: {} },
      ]);
    if (x < 0.8) return Object.assign(Object.create(null), { inner: value(depth + 1) });
    if (x < 0.82) return new Date(0);
    if (x < 0.86 && shared.length) return pick(r, shared);
    const s = section(depth + 1);
    shared.push(s);
    return s;
  };
  const object = (depth: number): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = Math.floor(r() * 4); i > 0; i--)
      o[pick(r, ["a", "b", "sections", "items", "slot"])] = value(depth);
    return o;
  };
  const section = (depth: number): Section => {
    const props = object(depth);
    if (r() < 0.1) props.__pageUrl = "https://saved.example/";
    if (r() < 0.1) props.__pagePath = "/saved";
    return { component: pick(r, COMPONENTS), props };
  };
  const sections = Array.from({ length: 1 + Math.floor(r() * 5) }, () => section(0));
  return {
    loaders,
    nonCritical,
    sections,
    pageUrl: `https://www.example.com${pick(r, PATHS)}${pick(r, QUERIES)}`,
    ua: pick(r, UAS),
    serverFn: r() < 0.3,
  };
}

/** A loader that records its calls, so both worlds' calls compare too. */
function recorded(
  world: World,
  loader: SectionLoaderFn | undefined,
  calls: unknown[],
  component: string,
) {
  if (!loader) return undefined;
  return ((props: Record<string, unknown>, req: Request, ctx: unknown) => {
    calls.push([
      component,
      world === "v7" ? rekey(props, "Component", "component") : props,
      req.url,
      req.headers.get("user-agent"),
    ]);
    return loader(props, req, ctx as never);
  }) as SectionLoaderFn;
}

async function runV7(c: Case, direct: boolean) {
  vi.mocked(console.error).mockClear();
  vi.mocked(console.warn).mockClear();
  const mod = direct ? v7Direct : v7Loaders;
  bag = new Map();
  deco.sectionLoaderRegistry.clear();
  deco.nonCriticalSections.clear();
  deco.layoutSections.clear();
  const calls: unknown[] = [];
  const loaders: Record<string, unknown> = {};
  for (const [component, kind] of Object.entries(c.loaders)) {
    const fn = recorded("v7", makeLoader(kind, "v7", v7Mixins), calls, component);
    if (fn) loaders[component] = fn;
  }
  mod.registerSectionLoaders(loaders);
  mod.registerNonCriticalSections(c.nonCritical);
  // v7 resolved nested sections as { Component, props }; the page's own sections keep `component`.
  const sections = c.sections.map((s, i) => ({
    component: s.component,
    key: s.component,
    index: i,
    props: rekey(s.props, "component", "Component"),
  }));
  const request = new Request(c.pageUrl, { headers: { "user-agent": c.ua } });
  const out = await mod.runSectionLoaders(sections, request);
  return {
    sections: rekey(out, "Component", "component"),
    degraded: [...mod.getDegradedSections()].sort(),
    calls,
  };
}

async function runV8(c: Case, direct: boolean) {
  const calls: unknown[] = [];
  const loaders: Record<string, SectionLoaderFn> = {};
  for (const [component, kind] of Object.entries(c.loaders)) {
    const fn = recorded(
      "v8",
      makeLoader(kind, "v8", {
        withDevice,
        withMobile,
        withSearchParam,
        compose,
        withSectionLoader,
      }),
      calls,
      component,
    );
    if (fn) loaders[component] = fn;
  }
  const sections = c.sections.map((s, i) => ({ ...s, key: s.component, index: i }));
  const headers = { "user-agent": c.ua };
  const request = c.serverFn
    ? new Request("https://www.example.com/_serverFn/abc123?createServerFn", {
        method: "POST",
        headers,
        body: "{}",
      })
    : new Request(c.pageUrl, { headers });
  const out = await runSectionLoaders(sections, {
    loaders,
    request,
    url: c.serverFn ? c.pageUrl : undefined,
    nonCritical: c.nonCritical,
    nested: direct ? "direct" : "deep",
  });
  return { sections: out.sections, degraded: [...out.degraded].sort(), calls };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

describe("runSectionLoaders, against v7's runner", () => {
  for (const [label, direct, seed] of [
    ["latest 7.x (nested: deep)", false, 1],
    ["7.77.12 (nested: direct)", true, 2],
  ] as const) {
    it(`${label}: 4,000 generated pages give v7's sections, degraded sections and loader calls`, async () => {
      const r = rng(seed);
      let nestedRuns = 0;
      for (let n = 0; n < 4000; n++) {
        const c = genCase(r);
        const v7 = await runV7(c, direct);
        const v8 = await runV8(c, direct);
        expect(v8.sections, `case ${n}`).toEqual(v7.sections);
        expect(v8.degraded, `case ${n}`).toEqual(v7.degraded);
        expect(v8.calls, `case ${n}`).toEqual(v7.calls);
        nestedRuns +=
          v7.calls.length - c.sections.filter((s) => c.loaders[s.component] !== "none").length;
      }
      // The generator does reach nested sections (and the comparison isn't vacuous).
      expect(nestedRuns).toBeGreaterThan(4000);
    }, 60_000);
  }

  it("deep and direct differ where 7.x #648 changed it: a section inside a plain object", async () => {
    const c: Case = {
      loaders: { "site/sections/Tabs.tsx": "none", "site/sections/Shelf.tsx": "add" },
      nonCritical: [],
      sections: [
        {
          component: "site/sections/Tabs.tsx",
          props: {
            variants: [{ name: "a", section: { component: "site/sections/Shelf.tsx", props: {} } }],
          },
        },
      ],
      pageUrl: "https://www.example.com/x",
      ua: "",
      serverFn: false,
    };
    const deep = await runV8(c, false);
    const direct = await runV8(c, true);
    expect(deep).toEqual(await runV7(c, false));
    expect(direct).toEqual(await runV7(c, true));
    expect(deep.calls).toHaveLength(1);
    expect(direct.calls).toHaveLength(0);
  });

  it("gives each loader the page URL and the request's headers, not a server-function call", async () => {
    const seen: unknown[] = [];
    const request = new Request("https://www.example.com/_serverFn/x", {
      method: "POST",
      headers: { "user-agent": UAS[0], cookie: "a=1" },
      body: "{}",
    });
    await runSectionLoaders([{ component: "S", props: {} }], {
      loaders: {
        S: (props, req) => {
          seen.push(
            props.__pageUrl,
            props.__pagePath,
            req.url,
            req.method,
            req.headers.get("cookie"),
          );
          return props;
        },
      },
      request,
      url: new URL("https://www.example.com/p/1?q=x"),
    });
    expect(seen).toEqual([
      "https://www.example.com/p/1?q=x",
      "/p/1",
      "https://www.example.com/p/1?q=x",
      "GET",
      "a=1",
    ]);
  });

  it("keeps the saved props of a failing section and reports it degraded, unless non-critical", async () => {
    const fail = () => {
      throw new Error("down");
    };
    const sections = [
      { component: "A", props: { x: 1 } },
      { component: "B", props: { y: 2, child: { component: "A", props: { z: 3 } } } },
    ];
    const request = new Request("https://www.example.com/");
    const out = await runSectionLoaders(sections, { loaders: { A: fail, B: fail }, request });
    expect(out.sections).toEqual(sections);
    expect(out.degraded.sort()).toEqual(["A", "B"]);
    const quiet = await runSectionLoaders(sections, {
      loaders: { A: fail, B: fail },
      request,
      nonCritical: ["A"],
    });
    expect(quiet.degraded).toEqual(["B"]);
    expect(console.error).toHaveBeenCalledWith('[SectionLoader] Error in "A":', expect.any(Error));
  });

  it("returns the same section and props when nothing ran", async () => {
    const props = { list: [1, { a: 2 }], obj: { b: null } };
    const section = { component: "A", props };
    const { section: out, degraded } = await runSectionLoader(section, {
      loaders: {},
      request: new Request("https://x.example/"),
    });
    expect(out).toBe(section);
    expect(degraded).toEqual([]);
  });

  it("terminates on cyclic loader output, with v7's result", async () => {
    const ring = (key: string) => {
      const head: Record<string, unknown> = { child: { [key]: "Leaf", props: {} } };
      let node = head;
      for (let i = 0; i < 40; i++) node = node.next = {};
      node.next = head;
      return head;
    };
    const leaf = (p: Record<string, unknown>) => ({ ...p, ran: true });
    const request = new Request("https://x.example/");
    const ours = await runSectionLoaders([{ component: "A", props: {} }], {
      loaders: { A: () => ({ loop: ring("component") }), Leaf: leaf },
      request,
    });
    deco.sectionLoaderRegistry.clear();
    v7Loaders.registerSectionLoaders({ A: () => ({ loop: ring("Component") }), Leaf: leaf });
    const theirs = await v7Loaders.runSectionLoaders([{ component: "A", props: {} }], request);
    expect(ours.sections).toEqual(rekey(theirs, "Component", "component"));
    const props = ours.sections[0].props as { loop: { child: { props: unknown } } };
    expect(props.loop.child.props).toEqual({
      __pageUrl: "https://x.example/",
      __pagePath: "/",
      ran: true,
    });
  });

  it("finds no loader for an inherited key", async () => {
    const out = await runSectionLoaders([{ component: "toString", props: {} }], {
      loaders: {},
      request: new Request("https://x.example/"),
    });
    expect(out.sections[0].props).toEqual({});
  });

  it("asks for the request", async () => {
    await expect(
      // @ts-expect-error: no request
      runSectionLoaders([], { loaders: {} }),
    ).rejects.toThrow(/pass the request being served/);
  });
});

describe("ctx is gone", () => {
  const request = new Request("https://www.example.com/");

  it("a loader that reads ctx throws with the way out, keeps its saved props and degrades the page", async () => {
    const v7Loader = async (props: Record<string, unknown>, _req: Request, ctx: any) => ({
      ...props,
      device: ctx.device,
    });
    const out = await runSectionLoaders(
      [{ component: "site/sections/Shelf.tsx", props: { a: 1 } }],
      {
        loaders: { "site/sections/Shelf.tsx": v7Loader },
        request,
      },
    );
    expect(out.sections[0].props).toEqual({ a: 1 });
    expect(out.degraded).toEqual(["site/sections/Shelf.tsx"]);
    const [, error] = vi.mocked(console.error).mock.calls[0];
    expect(String(error)).toMatch(
      /the loader of "site\/sections\/Shelf\.tsx" read ctx\.device, and v8 has no ctx/,
    );
    expect(String(error)).toMatch(/detectDevice/);
  });

  it("throws on ctx.invoke, app state, `in`, writes and spreading", async () => {
    const reads: ((ctx: any) => unknown)[] = [
      (ctx) => ctx.invoke.vtex.loaders.x({}),
      (ctx) => ctx.vtex?.account,
      (ctx) => ctx.response.headers,
      (ctx) => "device" in ctx,
      (ctx) => {
        ctx.x = 1;
      },
      (ctx) => ({ ...ctx }),
      (ctx) => Object.keys(ctx),
    ];
    for (const read of reads) {
      const out = await runSectionLoaders([{ component: "S", props: {} }], {
        loaders: {
          S: (props: Record<string, unknown>, _req: Request, ctx?: never) => ({
            ...props,
            v: read(ctx),
          }),
        },
        request,
      });
      expect(out.degraded, String(read)).toEqual(["S"]);
    }
  });

  it("is harmless when only passed along or awaited: compose forwards it, as v7 did", async () => {
    const out = await runSectionLoaders([{ component: "S", props: {} }], {
      loaders: {
        S: compose(withMobile(), async (props, _req, ctx) => ({
          ...props,
          awaited: (await ctx) === ctx,
        })),
      },
      request,
    });
    expect(out.degraded).toEqual([]);
    expect(out.sections[0].props).toMatchObject({ isMobile: false, awaited: true });
  });

  it("inside withSectionLoader, v7's catch keeps the props (not degraded), as on v7", async () => {
    const loader = withSectionLoader(async () => ({
      loader: (_props: unknown, _req: Request, ctx: any) => ctx.invoke,
    }));
    const out = await runSectionLoaders([{ component: "S", props: { a: 1 } }], {
      loaders: { S: loader },
      request,
    });
    expect(out.degraded).toEqual([]);
    expect(out.sections[0].props).toEqual({
      a: 1,
      __pageUrl: "https://www.example.com/",
      __pagePath: "/",
    });
  });
});

// ---------------------------------------------------------------------------
// The mixins
// ---------------------------------------------------------------------------

async function settle(fn: () => unknown): Promise<unknown> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { threw: String(error) };
  }
}

describe("the mixins, against v7's sectionMixins.ts", () => {
  it("withDevice, withMobile, withSearchParam and compose: 20,000 generated requests", async () => {
    const r = rng(3);
    const chars = ["q", "=", "&", "?", "%", "2", "0", "C3", "A9", "+", "a", "#", "/", "E0", "x"];
    for (let n = 0; n < 20_000; n++) {
      let search = "";
      for (let i = Math.floor(r() * 12); i > 0; i--) search += pick(r, chars);
      const url = `https://www.example.com/${pick(r, PATHS)}?${search}`;
      const ua =
        r() < 0.5
          ? pick(r, UAS)
          : Array.from({ length: 5 }, () =>
              pick(r, ["iPad", "Android", "Mobile", "x", " ", "Silk", "iPhone", "kindle"]),
            ).join("");
      const req = new Request(url, { headers: { "user-agent": ua } });
      const props = { a: n, isMobile: "saved", currentSearchParam: "saved" };
      for (const name of ["withDevice", "withMobile", "withSearchParam"] as const) {
        const ours = { withDevice, withMobile, withSearchParam }[name]();
        const theirs = v7Mixins[name]();
        expect([n, name, await settle(() => ours(props, req))]).toEqual([
          n,
          name,
          await settle(() => theirs(props, req)),
        ]);
        expect((ours as { __requestDependent?: boolean }).__requestDependent).toBe(
          theirs.__requestDependent,
        );
      }
      const ours = compose(withSearchParam(), withDevice(), withMobile());
      const theirs = v7Mixins.compose(
        v7Mixins.withSearchParam(),
        v7Mixins.withDevice(),
        v7Mixins.withMobile(),
      );
      expect(await settle(() => ours(props, req))).toEqual(await settle(() => theirs(props, req)));
    }
  }, 60_000);

  it("compose merges left to right, awaits each, and carries the request-dependent flag as v7 did", async () => {
    const req = new Request("https://x.example/?q=1");
    const plain = (p: Record<string, unknown>) => ({ ...p, n: ((p.n as number) ?? 0) + 1 });
    const later = async (p: Record<string, unknown>) => ({ n: (p.n as number) * 10, extra: true });
    const ours = compose(plain, later, plain);
    const theirs = v7Mixins.compose(plain, later, plain);
    expect(await ours({ a: 1 }, req)).toEqual(await theirs({ a: 1 }, req));
    expect((ours as { __requestDependent?: boolean }).__requestDependent).toBe(
      theirs.__requestDependent,
    );
    expect(
      (compose(plain, withSearchParam()) as { __requestDependent?: boolean }).__requestDependent,
    ).toBe(true);
    expect(v7Mixins.compose(plain, v7Mixins.withSearchParam()).__requestDependent).toBe(true);
  });

  it("withSectionLoader: no module loader, a loader returning nothing, a throwing loader, as v7", async () => {
    const req = new Request("https://x.example/");
    const modules = [
      async () => ({}),
      async () => undefined,
      async () => ({ loader: "not a function" }),
      async () => ({ loader: () => undefined }),
      async () => ({ loader: () => null }),
      async () => ({ loader: async (p: object) => ({ ...p, loaded: true }) }),
      async () => ({
        loader: () => {
          throw new Error("x");
        },
      }),
      async () => {
        throw new Error("import failed");
      },
    ];
    for (const mod of modules) {
      expect(await settle(() => withSectionLoader(mod)({ a: 1 }, req))).toEqual(
        await settle(() => v7Mixins.withSectionLoader(mod)({ a: 1 }, req)),
      );
    }
  });
});
