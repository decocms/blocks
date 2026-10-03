// @vitest-environment node
/**
 * Conformance: the runtime claims of the guide pages (quickstart,
 * how-it-works, nextjs, tanstack-start-descriptors, renames-and-migrations,
 * troubleshooting, internals, design-decisions), checked against the public
 * surface (`@decocms/blocks`, `/analytics`, `/fetch`) the way an app uses it.
 *
 * Each `it` names the claim id it checks. A failing test is a gap between the
 * docs and the code; the fix makes it green, never the assertion.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Block,
  type CMSError,
  createCMS,
  type Loader,
  matchRoute,
  type Redirect,
  remoteLoader,
  resetForTests,
  type Snapshot,
} from "@decocms/blocks";
import { AnalyticsScript } from "@decocms/blocks/analytics";
import { createInstrumentedFetch } from "@decocms/blocks/fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDestination } from "../telemetry";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let seq = 0;
/** A fresh snapshot object (each is its own CMS instance: no `root`). */
function snap(blocks: Record<string, unknown>, revision = `rev-${++seq}`): Snapshot {
  return { revision, blocks };
}

beforeEach(() => resetForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Quickstart
// ---------------------------------------------------------------------------

interface Experiments {
  newCheckout: number;
  stickyHeader: number;
  freeShippingBanner: number;
}
const roll = (percent: number) => Math.random() * 100 < percent;
function experiments(input: Experiments) {
  return {
    newCheckout: roll(input.newCheckout),
    stickyHeader: roll(input.stickyHeader),
    freeShippingBanner: roll(input.freeShippingBanner),
  };
}

describe("quickstart", () => {
  it("qs-12: forRelease() returns a client with resolve/list/revision; forDraft is a sibling", () => {
    const cms = createCMS({ blocks: { experiments }, content: snap({}) });
    const client = cms.forRelease();
    expect(typeof client.resolve).toBe("function");
    expect(typeof client.list).toBe("function");
    expect(typeof client.revision).toBe("function");
    expect(typeof cms.forDraft).toBe("function");
  });

  it("qs-13/qs-15: resolve('Experiments') runs the function on saved inputs, [value, null]; 100 is always true", async () => {
    const cms = createCMS({
      blocks: { experiments },
      content: snap({
        Experiments: {
          __resolveType: "experiments",
          newCheckout: 100,
          stickyHeader: 50,
          freeShippingBanner: 0,
        },
      }),
    });
    for (let i = 0; i < 20; i++) {
      const [flags, error] = await cms
        .forRelease()
        .resolve<ReturnType<typeof experiments>>("Experiments");
      expect(error).toBeNull();
      expect(flags?.newCheckout).toBe(true);
      expect(flags?.freeShippingBanner).toBe(false);
      expect(typeof flags?.stickyHeader).toBe("boolean");
    }
  });

  it("qs-07: block type `experiments` and saved block `Experiments` don't clash (case-sensitive)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createCMS({
      blocks: { experiments },
      content: snap({
        Experiments: {
          __resolveType: "experiments",
          newCheckout: 0,
          stickyHeader: 0,
          freeShippingBanner: 0,
        },
      }),
    });
    const [flags, error] = await cms.forRelease().resolve("Experiments");
    expect(error).toBeNull();
    expect(flags).toEqual({ newCheckout: false, stickyHeader: false, freeShippingBanner: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("qs-14: a missing block and a throwing function return error tuples, never throw", async () => {
    const cms = createCMS({
      blocks: {
        boom: () => {
          throw new Error("upstream down");
        },
      },
      content: snap({ Broken: { __resolveType: "boom" } }),
    });
    const client = cms.forRelease();
    const [missing, notFound] = await client.resolve("Missing");
    expect(missing).toBeNull();
    expect(notFound?.code).toBe("NOT_FOUND");
    const [value, failed] = await client.resolve("Broken");
    expect(value).toBeNull();
    expect(failed?.code).toBe("BLOCK_FAILED");
  });

  it("qs-16/dd-17: block functions receive exactly one argument, their inputs (no context)", async () => {
    const spy = vi.fn((input: { title: string }) => input.title);
    const cms = createCMS({
      blocks: { title: spy },
      content: snap({ T: { __resolveType: "title", title: "hi" } }),
    });
    const [value] = await cms.forRelease().resolve("T");
    expect(value).toBe("hi");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(1);
    expect(spy.mock.calls[0][0]).toEqual({ title: "hi" });
  });

  it("qs-17/hiw-06/dd-03: exactly ten built-ins, the design-decisions nine plus secret, all resolvable", async () => {
    const { builtIns } = await import("../builtins/index");
    expect(Object.keys(builtIns).sort()).toEqual(
      [
        "page",
        "redirect",
        "telemetry",
        "analytics",
        "always",
        "never",
        "date",
        "multivariate",
        "lazy",
        "secret",
      ].sort(),
    );
    const client = createCMS({ blocks: {}, content: snap({}) }).forRelease();
    for (const [type, inputs] of [
      ["always", {}],
      ["never", {}],
      ["date", {}],
      ["page", { name: "x", path: "/", sections: [] }],
      ["redirect", { from: "/a", to: "/b", permanent: false }],
      ["telemetry", {}],
      ["analytics", {}],
      ["multivariate", { variants: [] }],
    ] as const) {
      const [, error] = await client.resolve({ __resolveType: type, ...inputs });
      expect(error, type).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

describe("how it works", () => {
  it("hiw-01: { __resolveType: 'promo-banner', title } calls the block map's promo-banner", async () => {
    const PromoBanner = ({ title }: { title: string }) => ({ banner: title });
    const cms = createCMS({
      blocks: { "promo-banner": PromoBanner },
      content: snap({
        SummerBanner: { __resolveType: "promo-banner", title: "Free shipping over $50" },
      }),
    });
    const client = cms.forRelease();
    expect(await client.resolve("SummerBanner")).toEqual([
      { banner: "Free shipping over $50" },
      null,
    ]);
    expect(
      await client.resolve({ __resolveType: "promo-banner", title: "Free shipping over $50" }),
    ).toEqual([{ banner: "Free shipping over $50" }, null]);
  });

  it("hiw-05: forDraft takes a draft pointer argument", () => {
    const cms = createCMS({ blocks: {}, content: snap({}) });
    expect(cms.forDraft.length).toBe(1);
  });

  it("hiw-07: a lazy block resolves only when asked; date returns a boolean", async () => {
    const inner = vi.fn(({ n }: { n: number }) => n * 2);
    let received: unknown;
    const cms = createCMS({
      blocks: {
        double: inner,
        holder: (input: { later: () => Promise<number> }) => {
          received = input.later;
          return "held";
        },
      },
      content: snap({
        Holder: {
          __resolveType: "holder",
          later: { __resolveType: "lazy", value: { __resolveType: "double", n: 21 } },
        },
      }),
    });
    const client = cms.forRelease();
    await client.resolve("Holder");
    expect(typeof received).toBe("function");
    expect(inner).not.toHaveBeenCalled();
    expect(await (received as () => Promise<number>)()).toBe(42);
    expect(inner).toHaveBeenCalledTimes(1);

    const [isOn] = await client.resolve({
      __resolveType: "date",
      start: "2000-01-01",
      end: "2999-01-01",
    });
    expect(isOn).toBe(true);
    const [isOff] = await client.resolve({ __resolveType: "date", end: "2000-01-01" });
    expect(isOff).toBe(false);
  });

  it("hiw-04/mig-06/dd-17: the v8 surface has no invoke handler, no cachedLoader and no requestScope", () => {
    const v8 = path.join(SRC, "v8");
    const files = walk(v8).filter((f) => !/\.test\.tsx?$|__conformance__|__tests__/.test(f));
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\/deco\/invoke|handleInvoke/);
      expect(text, file).not.toMatch(/\bcachedLoader\b(?!`)/);
      expect(text, file).not.toMatch(/requestScope/);
    }
    const root = fs.readFileSync(path.join(SRC, "v8/index.ts"), "utf8");
    expect(root).not.toMatch(/requestScope|cachedLoader|invoke/i);
  });
});

// ---------------------------------------------------------------------------
// Next.js guide
// ---------------------------------------------------------------------------

const promoBanner = (input: { title: string; href: string }) => ({ promo: input.title });
const productHero = (input: { name: string }) => ({ hero: input.name });
const nextBlocks = {
  seo: (input: { title: string; description: string }) => input,
  "promo-banner": promoBanner,
  "product-hero": productHero,
  post: (props: { name: string; path: string; date: string }) => props,
};
function nextContent(): Snapshot {
  return snap({
    ShirtPage: {
      __resolveType: "page",
      name: "Summer shirt",
      path: "/:slug/p",
      seo: { __resolveType: "seo", title: "Summer shirt", description: "Light cotton shirt." },
      sections: [
        { __resolveType: "promo-banner", title: "Free shipping over $50", href: "/shipping" },
        { __resolveType: "product-hero", name: "Summer shirt" },
      ],
    },
    LegacyProduct: {
      __resolveType: "redirect",
      from: "/old-products/:slug",
      to: "/:slug/p",
      permanent: true,
    },
    Moved: { __resolveType: "redirect", from: "/moved", to: "/new", permanent: false, status: 308 },
    HelloWorld: {
      __resolveType: "post",
      name: "Hello, world",
      path: "/blog/hello-world",
      date: "2026-09-01",
    },
    Older: { __resolveType: "post", name: "Older", path: "/blog/older", date: "2025-01-01" },
  });
}

describe("nextjs guide", () => {
  it("nx-01/dd-13: the SDK runtime never imports node:fs (Node, Edge, Workers alike)", () => {
    const runtime = runtimeFiles();
    expect(runtime.length).toBeGreaterThan(5);
    for (const file of runtime) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/from "(node:)?fs(\/promises)?"/);
    }
  });

  it("nx-04: page and redirect resolve with no block-map entry; JSX-like sections resolve in the page", async () => {
    const cms = createCMS({ blocks: nextBlocks, content: nextContent() });
    const [page, error] = await cms.forRelease().resolve("ShirtPage");
    expect(error).toBeNull();
    expect(page).toMatchObject({
      sections: [{ promo: "Free shipping over $50" }, { hero: "Summer shirt" }],
    });
  });

  it("nx-09/nx-10: matchRoute returns not-found, redirect with status and location, or a match with entry", async () => {
    const client = createCMS({ blocks: nextBlocks, content: nextContent() }).forRelease();
    const [pages] = await client.list<Block & { name: string; path: string }>("page");
    const [redirects] = await client.list<Redirect>("redirect");
    expect(matchRoute("/nope", { routes: pages!, redirects: redirects! })).toEqual({
      kind: "not-found",
    });
    const redirect = matchRoute("/old-products/shirt", { routes: pages!, redirects: redirects! });
    expect(redirect).toMatchObject({ kind: "redirect", location: "/shirt/p", status: 301 });
    expect(matchRoute("/moved", { routes: pages!, redirects: redirects! })).toMatchObject({
      kind: "redirect",
      status: 308,
    });
    const match = matchRoute("/shirt/p", { routes: pages!, redirects: redirects! });
    expect(match.kind).toBe("match");
    if (match.kind === "match") expect(match.entry).toBe(pages![0]);
  });

  it("nx-11/tr-09: list returns entries as saved (not run); { run: true } runs them", async () => {
    const hero = vi.fn(productHero);
    const client = createCMS({
      blocks: { ...nextBlocks, "product-hero": hero },
      content: nextContent(),
    }).forRelease();
    const [pages, error] = await client.list<Block & { sections: Block[] }>("page");
    expect(error).toBeNull();
    expect(pages).toHaveLength(1);
    expect(pages![0].sections[0].__resolveType).toBe("promo-banner");
    expect(hero).not.toHaveBeenCalled();
    const [viaResolve] = await client.resolve("ShirtPage", { run: false });
    expect(viaResolve).toEqual(pages![0]);
    const [run] = await client.list<{ sections: unknown[] }>("page", { run: true });
    expect(run![0].sections).toEqual([
      { promo: "Free shipping over $50" },
      { hero: "Summer shirt" },
    ]);
  });

  it("nx-12: resolve(match.entry) on a listed page resolves seo and every section", async () => {
    const client = createCMS({ blocks: nextBlocks, content: nextContent() }).forRelease();
    const [pages] = await client.list<Block & { name: string; path: string }>("page");
    const match = matchRoute("/shirt/p", { routes: pages! });
    if (match.kind !== "match") throw new Error("expected a match");
    const [page, error] = await client.resolve<{ seo: unknown; sections: unknown[] }>(match.entry);
    expect(error).toBeNull();
    expect(page?.seo).toEqual({ title: "Summer shirt", description: "Light cotton shirt." });
    expect(page?.sections).toEqual([{ promo: "Free shipping over $50" }, { hero: "Summer shirt" }]);
  });

  it("nx-15: one failing block fails the whole page", async () => {
    const client = createCMS({
      blocks: {
        ...nextBlocks,
        "product-hero": () => {
          throw new Error("down");
        },
      },
      content: nextContent(),
    }).forRelease();
    const [page, error] = await client.resolve("ShirtPage");
    expect(page).toBeNull();
    expect(error?.code).toBe("BLOCK_FAILED");
  });

  it("nx-16/nx-17: posts list and route by path; __resolveType identifies them; sort works", async () => {
    const client = createCMS({ blocks: nextBlocks, content: nextContent() }).forRelease();
    const [pages] = await client.list<Block & { name: string; path: string }>("page");
    const [posts] = await client.list<Block & { name: string; path: string; date: string }>(
      "post",
      { sort: (a, b) => b.date.localeCompare(a.date) },
    );
    expect(posts!.map((p) => p.name)).toEqual(["Hello, world", "Older"]);
    const match = matchRoute("/blog/hello-world", { routes: [...pages!, ...posts!] });
    expect(match.kind).toBe("match");
    if (match.kind === "match") expect(match.entry.__resolveType).toBe("post");
    const [asc] = await client.list<{ date: string }>("post", {
      sort: (a, b) => a.date.localeCompare(b.date),
    });
    expect(asc!.map((p) => p.date)).toEqual(["2025-01-01", "2026-09-01"]);
  });

  it("nx-19: resolve(undefined) (a page without seo) is [undefined, null]", async () => {
    const client = createCMS({ blocks: nextBlocks, content: nextContent() }).forRelease();
    const [value, error] = await client.resolve(undefined);
    expect(value).toBeUndefined();
    expect(error).toBeNull();
  });

  it("nx-20: sections saved as one multivariate block resolves to the chosen list", async () => {
    const client = createCMS({
      blocks: nextBlocks,
      content: snap({
        P: {
          __resolveType: "page",
          name: "P",
          path: "/p",
          sections: {
            __resolveType: "multivariate",
            variants: [
              {
                rule: { __resolveType: "never" },
                value: {
                  __resolveType: "lazy",
                  value: [{ __resolveType: "product-hero", name: "A" }],
                },
              },
              {
                rule: { __resolveType: "always" },
                value: {
                  __resolveType: "lazy",
                  value: [{ __resolveType: "product-hero", name: "B" }],
                },
              },
            ],
          },
        },
      }),
    }).forRelease();
    const [pages] = await client.list<{ sections: unknown }>("page");
    expect(Array.isArray(pages![0].sections)).toBe(false);
    const [list, error] = await client.resolve(pages![0].sections);
    expect(error).toBeNull();
    expect(list).toEqual([{ hero: "B" }]);
    const [page] = await client.resolve<{ sections: unknown }>("P");
    expect(page?.sections).toEqual([{ hero: "B" }]);
  });

  it("nx-22: a hidden block (no variant chosen) resolves to undefined with no error", async () => {
    const client = createCMS({ blocks: nextBlocks, content: snap({}) }).forRelease();
    const [value, error] = await client.resolve({
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "never" },
          value: { __resolveType: "lazy", value: { __resolveType: "product-hero", name: "x" } },
        },
      ],
    });
    expect(value).toBeUndefined();
    expect(error).toBeNull();
  });

  it("nx-28: list reads memory: one content load however many lists", async () => {
    const load = vi.fn(async () => nextContent());
    const cms = createCMS({
      blocks: nextBlocks,
      content: { load, update: async () => ({ updated: false }) },
    });
    for (let i = 0; i < 5; i++) {
      const client = cms.forRelease();
      await client.list("page");
      await client.list("post");
    }
    expect(load).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TanStack Start guide
// ---------------------------------------------------------------------------

describe("tanstack-start guide", () => {
  it("ts-02: a `page` key replaces the built-in page; built-in redirect is still there", async () => {
    const page = vi.fn((input: { sections: unknown[] }) => ({ custom: true, ...input }));
    const client = createCMS({
      blocks: { ...nextBlocks, page },
      content: nextContent(),
    }).forRelease();
    const [resolved] = await client.resolve<{ custom: boolean }>("ShirtPage");
    expect(resolved?.custom).toBe(true);
    expect(page).toHaveBeenCalledTimes(1);
    const [redirects, error] = await client.list<Redirect>("redirect");
    expect(error).toBeNull();
    expect(redirects).toHaveLength(2);
    const [r] = await client.resolve("LegacyProduct");
    expect(r).toMatchObject({ from: "/old-products/:slug" });
  });

  it("ts-05: matchRoute accepts an href with a search string", async () => {
    const client = createCMS({ blocks: nextBlocks, content: nextContent() }).forRelease();
    const [pages] = await client.list<Block & { name: string; path: string }>("page");
    const [redirects] = await client.list<Redirect>("redirect");
    expect(matchRoute("/shirt/p?color=blue", { routes: pages!, redirects: redirects! }).kind).toBe(
      "match",
    );
    expect(
      matchRoute("/old-products/shirt?utm=x", { routes: pages!, redirects: redirects! }),
    ).toMatchObject({ kind: "redirect", location: "/shirt/p?utm=x" });
  });

  it("ts-06: a successful resolve's error is exactly null", async () => {
    const client = createCMS({ blocks: nextBlocks, content: nextContent() }).forRelease();
    const [, error] = await client.resolve({ __resolveType: "product-hero", name: "x" });
    expect(error).toBe(null);
  });

  it("ts-04: on Workers with only @decocms/blocks (no binding), background work goes to waitUntil", async () => {
    // The guide installs only @decocms/blocks and uses Start's own server
    // entry, so no binding installs the background hook. Workers run no
    // timers after the response, so the core itself must hand the work to
    // the platform's waitUntil (cloudflare:workers) to keep the docs' promise.
    const waitUntil = vi.fn();
    vi.doMock("cloudflare:workers", () => ({ waitUntil }));
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.resetModules();
    const { runInBackground } = await import("../background");
    runInBackground(async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(waitUntil).toHaveBeenCalledTimes(1);
    vi.doUnmock("cloudflare:workers");
  });
});

// ---------------------------------------------------------------------------
// Migrating from v7
// ---------------------------------------------------------------------------

describe("renames and migrations", () => {
  it("mig-01/mig-02: an alias key resolves legacy content; routing ignores type names", async () => {
    const productCard = (input: { title: string }) => ({ card: input.title });
    type CardInput = Parameters<typeof productCard>[0];
    const client = createCMS({
      blocks: {
        "product-card": productCard,
        "site/sections/Product.tsx": ({
          name,
          ...rest
        }: Omit<CardInput, "title"> & { name: string }) => productCard({ ...rest, title: name }),
      },
      content: snap({
        Legacy: { __resolveType: "site/sections/Product.tsx", name: "Shirt" },
        Old: {
          __resolveType: "website/pages/Page.tsx",
          name: "Old",
          path: "/old",
          sections: [{ __resolveType: "site/sections/Product.tsx", name: "Shirt" }],
        },
      }),
    }).forRelease();
    expect(await client.resolve("Legacy")).toEqual([{ card: "Shirt" }, null]);
    const [pages] = await client.list<Block & { name: string; path: string }>("page");
    expect(pages).toHaveLength(1);
    const match = matchRoute("/old", { routes: pages! });
    expect(match.kind).toBe("match");
  });

  it("mig-03: website/pages/Page.tsx resolves as the built-in page with no block-map entry", async () => {
    const client = createCMS({
      blocks: {},
      content: snap({
        Old: { __resolveType: "website/pages/Page.tsx", name: "Old", path: "/old", sections: [] },
      }),
    }).forRelease();
    expect(await client.resolve("Old")).toEqual([
      { name: "Old", path: "/old", sections: [] },
      null,
    ]);
  });

  it("mig-04: website/flags/multivariate.ts maps to multivariate; plain values are wrapped lazily", async () => {
    const a = vi.fn(() => "A");
    const b = vi.fn(() => "B");
    const client = createCMS({
      blocks: { a, b },
      content: snap({
        Flag: {
          __resolveType: "website/flags/multivariate.ts",
          variants: [
            { rule: { __resolveType: "website/matchers/never.ts" }, value: { __resolveType: "a" } },
            {
              rule: { __resolveType: "website/matchers/always.ts" },
              value: { __resolveType: "b" },
            },
          ],
        },
      }),
    }).forRelease();
    expect(await client.resolve("Flag")).toEqual(["B", null]);
    expect(a).not.toHaveBeenCalled();
  });

  it("mig-08/tr-18: telemetry option wins; env OTEL_EXPORTER_OTLP_* when left out; false disables", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://env.example.com");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-api-key=abc%20d");
    expect(resolveDestination(undefined)).toMatchObject({
      endpoint: "https://env.example.com",
      headers: { "x-api-key": "abc d" },
    });
    expect(
      resolveDestination({ endpoint: "https://code.example.com", headers: { a: "b" } }),
    ).toMatchObject({ endpoint: "https://code.example.com", headers: { a: "b" } });
    expect(resolveDestination(false)).toBeNull();
    vi.unstubAllEnvs();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    expect(resolveDestination(undefined)).toBeNull();
  });

  it("mig-09: telemetry: { site, token } is accepted and goes to the hosted collector", () => {
    const destination = resolveDestination({ site: "my-site", token: "t" });
    expect(destination?.endpoint).toMatch(/^https:\/\//);
    expect(() =>
      createCMS({ blocks: {}, content: snap({}), telemetry: { site: "my-site", token: "t" } }),
    ).not.toThrow();
  });

  it("mig-10/dd-16: the analytics block fills defaults; AnalyticsScript renders nothing when disabled", async () => {
    const client = createCMS({
      blocks: {},
      content: snap({ Analytics: { __resolveType: "analytics" } }),
    }).forRelease();
    const [settings, error] = await client.resolve<{ enabled: boolean; collector: string }>(
      "Analytics",
    );
    expect(error).toBeNull();
    expect(settings?.enabled).toBe(true);
    expect(settings?.collector).toMatch(/^https:\/\//);
    expect(AnalyticsScript({ ...settings, enabled: false })).toBeNull();
    expect(AnalyticsScript(settings ?? {})).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Troubleshooting
// ---------------------------------------------------------------------------

describe("troubleshooting", () => {
  it("tr-01: client.revision() is the content module's revision", async () => {
    const content = snap({}, "abc123");
    expect(await createCMS({ blocks: {}, content }).forRelease().revision()).toBe("abc123");
  });

  it("tr-02: resolve(target, { run: false }) expands references and runs nothing", async () => {
    const seo = vi.fn((x: unknown) => x);
    const client = createCMS({
      blocks: { seo },
      content: snap({
        SummerSEO: { __resolveType: "seo", title: "Sunny" },
        Page: {
          __resolveType: "page",
          name: "P",
          path: "/",
          seo: { __resolveType: "SummerSEO" },
          sections: [],
        },
      }),
    }).forRelease();
    const [entry] = await client.resolve<{ __resolveType: string; seo: Block }>("Page", {
      run: false,
    });
    expect(entry?.__resolveType).toBe("page");
    expect(entry?.seo).toEqual({ __resolveType: "seo", title: "Sunny" });
    expect(seo).not.toHaveBeenCalled();
  });

  it("tr-03: UNKNOWN_BLOCK for a name in neither the map nor saved blocks; case-sensitive", async () => {
    const client = createCMS({ blocks: nextBlocks, content: snap({}) }).forRelease();
    const [, error] = await client.resolve({ __resolveType: "Promo-banner", title: "x" });
    expect(error?.code).toBe("UNKNOWN_BLOCK");
  });

  it("tr-04: a block function whose dynamic import has no default export fails as BLOCK_FAILED", async () => {
    // Blocks never loads code for you (design-decisions: lazy loading code
    // belongs to the framework), so a broken import inside a function is that
    // function failing, not an unknown type.
    const client = createCMS({
      blocks: {
        lazyHero: async () => {
          const mod = (await import("../json")) as { default?: (x: unknown) => unknown };
          return mod.default!({});
        },
      },
      content: snap({}),
    }).forRelease();
    const [, error] = await client.resolve({ __resolveType: "lazyHero" });
    expect(error?.code).toBe("BLOCK_FAILED");
  });

  it("tr-05: a string target is a saved block name; an inline block runs a type", async () => {
    const client = createCMS({ blocks: nextBlocks, content: snap({}) }).forRelease();
    expect((await client.resolve("seo"))[1]?.code).toBe("NOT_FOUND");
    expect(await client.resolve({ __resolveType: "seo", title: "t", description: "d" })).toEqual([
      { title: "t", description: "d" },
      null,
    ]);
  });

  it("tr-06: CYCLE with error.path listing the references", async () => {
    const client = createCMS({
      blocks: {},
      content: snap({ A: { __resolveType: "B" }, B: { __resolveType: "A" } }),
    }).forRelease();
    const [, error] = await client.resolve("A");
    expect(error?.code).toBe("CYCLE");
    expect(error?.path).toEqual(["A", "B", "A"]);
  });

  it("tr-07: createCMS twice with same content, different options: warns and keeps the first", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = { ...snap({}), root: ".deco" };
    const first = createCMS({ blocks: {}, content, telemetry: false });
    const second = createCMS({ blocks: {}, content, telemetry: { endpoint: "https://x.example" } });
    expect(second).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/different options/));
  });

  it("tr-08/dd-01: a block type with a saved block's name wins (function runs)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createCMS({
      blocks: { Promo: () => "function" },
      content: snap({ Promo: { __resolveType: "Promo" } }),
    }).forRelease();
    expect(await client.resolve({ __resolveType: "Promo" })).toEqual(["function", null]);
  });

  it("tr-10: a client runs each block once and reuses the result; a new client runs again", async () => {
    const fn = vi.fn(() => ({ at: Math.random() }));
    const cms = createCMS({ blocks: { fn }, content: snap({ F: { __resolveType: "fn" } }) });
    const client = cms.forRelease();
    const [a] = await client.resolve("F");
    const [b] = await client.resolve("F");
    expect(a).toBe(b);
    expect(fn).toHaveBeenCalledTimes(1);
    await cms.forRelease().resolve("F");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("tr-11: a client never changes revision, even when the loader updates", async () => {
    let current = snap({ X: { __resolveType: "v", n: 1 } }, "r1");
    const loader: Loader = {
      load: async () => current,
      update: async () => {
        current = snap({ X: { __resolveType: "v", n: 2 } }, "r2");
        return { updated: true };
      },
    };
    const cms = createCMS({ blocks: { v: ({ n }: { n: number }) => n }, content: loader });
    const client = cms.forRelease();
    expect(await client.revision()).toBe("r1");
    await cms.update();
    expect(await client.revision()).toBe("r1");
    expect(await client.resolve("X")).toEqual([1, null]);
    expect(await cms.forRelease().revision()).toBe("r2");
  });

  it("tr-19: createInstrumentedFetch is exported and measures through the CMS's telemetry", async () => {
    const f = createInstrumentedFetch({
      provider: "acme",
      fetch: async () => new Response("ok"),
    });
    expect((await f("https://acme.example/x")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

describe("internals", () => {
  it("in-01: content.blocks[name] is the entry as stored", async () => {
    const content = nextContent();
    expect((content.blocks.ShirtPage as Block).__resolveType).toBe("page");
  });

  it("in-04/in-10: the runtime never imports the cli or protocol subpaths", () => {
    for (const file of runtimeFiles()) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from "[^"]*\/cli(\/[^"]*)?"/);
      expect(text, file).not.toMatch(/from "[^"]*protocol[^"]*"/);
    }
  });

  it("in-12: createCMS and remoteLoader reuse the instance a second module copy made", async () => {
    const content = { ...snap({}), root: ".deco-dual" };
    const first = createCMS({ blocks: {}, content });
    vi.resetModules();
    const copy = (await import(
      /* @vite-ignore */ `../cms?copy=${Date.now()}`
    )) as typeof import("../cms");
    expect(copy.createCMS({ blocks: {}, content })).toBe(first);
    const r1 = remoteLoader(content, { site: "s", token: "t" });
    const copyRemote = (await import(
      /* @vite-ignore */ `../remoteLoader?copy=${Date.now()}`
    )) as typeof import("../remoteLoader");
    expect(copyRemote.remoteLoader(content, { site: "s", token: "t" })).toBe(r1);
  });

  it("in-13: remoteLoader is exported from the root", () => {
    expect(typeof remoteLoader).toBe("function");
  });

  it("in-16: the layout cache race regression test still exists", () => {
    expect(fs.existsSync(path.join(SRC, "cms/layoutCacheRace.test.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Design decisions
// ---------------------------------------------------------------------------

describe("design decisions", () => {
  it("dd-01: a function's result is returned as is, never looked up again", async () => {
    const client = createCMS({
      blocks: { make: () => ({ __resolveType: "Other" }) },
      content: snap({ Other: { __resolveType: "never" } }),
    }).forRelease();
    expect(await client.resolve({ __resolveType: "make" })).toEqual([
      { __resolveType: "Other" },
      null,
    ]);
    const seo = createCMS({
      blocks: { seo: (x: unknown) => x },
      content: snap({ S: { __resolveType: "seo", title: "t" } }),
    }).forRelease();
    expect(await seo.resolve("S")).toEqual([{ title: "t" }, null]);
  });

  it("dd-01: built-ins sit under the user's map (a user key overrides a built-in)", async () => {
    const client = createCMS({ blocks: { always: () => false }, content: snap({}) }).forRelease();
    expect(await client.resolve({ __resolveType: "always" })).toEqual([false, null]);
  });

  it("dd-02: a lazy input becomes a Lazy<T> function", async () => {
    let got: unknown;
    const client = createCMS({
      blocks: {
        take: (x: { v: unknown }) => {
          got = x.v;
          return 1;
        },
      },
      content: snap({}),
    }).forRelease();
    await client.resolve({ __resolveType: "take", v: { __resolveType: "lazy", value: 5 } });
    expect(typeof got).toBe("function");
    expect(await (got as () => Promise<number>)()).toBe(5);
  });

  it("dd-05: multivariate runs only the first true variant; a user multivariate replaces it", async () => {
    const a = vi.fn(() => "A");
    const b = vi.fn(() => "B");
    const content = snap({});
    const client = createCMS({ blocks: { a, b }, content }).forRelease();
    const mv = {
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: { __resolveType: "a" } },
        },
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: { __resolveType: "b" } },
        },
      ],
    };
    expect(await client.resolve(mv)).toEqual(["A", null]);
    expect(b).not.toHaveBeenCalled();
    const own = createCMS({
      blocks: { a, b, multivariate: () => "mine" },
      content: snap({}),
    }).forRelease();
    expect(await own.resolve(mv)).toEqual(["mine", null]);
  });

  it("dd-10: many clients share one content load", async () => {
    const load = vi.fn(async () => snap({}));
    const cms = createCMS({
      blocks: {},
      content: { load, update: async () => ({ updated: false }) },
    });
    await Promise.all(Array.from({ length: 10 }, () => cms.forRelease().revision()));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("dd-11: content can be a Loader with load(pointer?) and optional update()", async () => {
    const pointers: unknown[] = [];
    const loader: Loader = {
      load: async (pointer) => {
        pointers.push(pointer);
        return snap({});
      },
    };
    const cms = createCMS({ blocks: {}, content: loader });
    await cms.forRelease().revision();
    await cms.forDraft("localhost:8000/x@v1").revision();
    expect(pointers[0] ?? null).toBeNull();
    expect(pointers[1]).toBe("localhost:8000/x@v1");
  });

  it("dd-12: a request never waits for update()", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const loader: Loader = {
      load: async () => snap({ X: { __resolveType: "always" } }, "r"),
      update: async () => {
        await slow;
        return { updated: false };
      },
    };
    const cms = createCMS({ blocks: {}, content: loader });
    const started = Date.now();
    const [value] = await cms.forRelease().resolve("X");
    expect(value).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    release();
  });

  it("dd-15/tr-18: sample rates above the code limit are capped; enabled: false sends nothing", async () => {
    const HOOK = Symbol.for("decocms.blocks.background");
    const tasks: (() => Promise<void>)[] = [];
    (globalThis as Record<symbol, unknown>)[HOOK] = (task: () => Promise<void>) => tasks.push(task);
    let clock = 0;
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + clock);
    const flush = async () => {
      while (tasks.length > 0) {
        clock += 10_000;
        await Promise.all(tasks.splice(0).map((t) => t()));
      }
    };
    const sent = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", sent);
    const broken = () => {
      throw new Error("no");
    };
    try {
      const capped = createCMS({
        blocks: { broken },
        content: snap({ Telemetry: { __resolveType: "telemetry", errorSampleRate: 1 } }),
        telemetry: { endpoint: "https://otel.example.com", limits: { errorSampleRate: 0.1 } },
      });
      vi.spyOn(Math, "random").mockReturnValue(0.5); // inside the editor's 1, above code's 0.1
      await capped.forRelease().resolve({ __resolveType: "broken" });
      await flush();
      expect(sent).not.toHaveBeenCalled();

      const off = createCMS({
        blocks: { broken },
        content: snap({
          Telemetry: { __resolveType: "telemetry", enabled: false, errorSampleRate: 1 },
        }),
        telemetry: { endpoint: "https://otel2.example.com", limits: { errorSampleRate: 1 } },
      });
      vi.spyOn(Math, "random").mockReturnValue(0);
      await off.forRelease().resolve({ __resolveType: "broken" });
      await flush();
      expect(sent).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as Record<symbol, unknown>)[HOOK];
    }
  });

  it("dd-14: remoteLoader keeps serving the content it has when the Deco API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const fallback = {
      ...snap({ X: { __resolveType: "always" } }, "build"),
      root: ".deco-offline",
    };
    const cms = createCMS({ blocks: {}, content: fallback, site: "s", token: "t" });
    const client = cms.forRelease();
    expect(await client.revision()).toBe("build");
    expect(await client.resolve("X")).toEqual([true, null]);
  });
});

// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

/** The SDK runtime: src/v8 minus the CLI, tests and fixtures. */
function runtimeFiles(): string[] {
  return walk(path.join(SRC, "v8")).filter(
    (f) =>
      /\.tsx?$/.test(f) &&
      !/\.test\.tsx?$/.test(f) &&
      !f.includes(`${path.sep}cli${path.sep}`) &&
      !f.includes("__fixtures__") &&
      !f.includes("__conformance__") &&
      !f.endsWith("testFixtures.ts"),
  );
}

export type { CMSError };
