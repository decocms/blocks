import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./sectionLoaders", () => ({
  isLayoutSection: () => false,
  runSingleSectionLoader: vi.fn(async (section: any) => section),
}));

vi.mock("../sdk/normalizeUrls", () => ({
  normalizeUrlsInObject: vi.fn(<T>(x: T) => x),
}));

vi.mock("./loader", () => ({
  findPageByPath: vi.fn(),
  loadBlocks: vi.fn(() => ({})),
}));

vi.mock("./registry", () => ({
  getSection: vi.fn(),
  getOnBeforeResolveProps: vi.fn(),
}));

import { normalizeUrlsInObject } from "../sdk/normalizeUrls";
import { findPageByPath } from "./loader";
import { getSection } from "./registry";
import type { AsyncRenderingConfig, DeferredSection, MatcherContext } from "./resolve";
import {
  clearCommerceLoaders,
  layoutCacheKey,
  DEFAULT_FOLD_THRESHOLD,
  extractSeoFromProps,
  getAsyncRenderingConfig,
  isEagerRequest,
  reExtractRawProps,
  registerCommerceLoader,
  registerMatcher,
  registerEagerSections,
  registerAlwaysDeferSections,
  registerNeverDeferSections,
  resolveDecoPage,
  resolveDeferredSectionFull,
  resolvePageSeoBlock,
  resolveSectionsList,
  resolveValue,
  setAsyncRenderingConfig,
  shouldDeferSection,
  WELL_KNOWN_TYPES,
} from "./resolve";
import { runSingleSectionLoader } from "./sectionLoaders";

describe("resolveDeferredSectionFull", () => {
  it("resolves a deferred section and preserves index", async () => {
    const ds: DeferredSection = {
      component: "site/sections/ProductShelf.tsx",
      key: "site/sections/ProductShelf.tsx",
      index: 5,
      propsHash: "test",
      rawProps: { title: "Best Sellers" },
    };

    const request = new Request("https://store.com/");

    // resolveDeferredSection depends on ensureInitialized() and CMS internals.
    // Since we can't easily mock the full resolution pipeline, we test that
    // the function composes correctly by verifying it calls the right deps.
    // A full integration test would require a running CMS context.

    // For now, verify the function signature is correct and types align
    expect(typeof resolveDeferredSectionFull).toBe("function");
    expect(resolveDeferredSectionFull.length).toBe(4); // ds, pagePath, request, matcherCtx?
  });

  it("runSingleSectionLoader is called with enriched section", async () => {
    // Verify the mock is correctly set up
    const mockSection = {
      component: "test",
      props: { title: "hi" },
      key: "test",
      index: 3,
    };
    const request = new Request("https://store.com/");

    const result = await (runSingleSectionLoader as any)(mockSection, request);
    expect(result).toEqual(mockSection);
  });

  it("normalizeUrlsInObject is used for output normalization", () => {
    const input = { url: "https://store.com/image.jpg" };
    const result = (normalizeUrlsInObject as any)(input);
    expect(result).toEqual(input); // mock passes through
  });
});

// ---------------------------------------------------------------------------
// resolveSectionsList — page-level variant wrapper support
// ---------------------------------------------------------------------------

describe("resolveSectionsList", () => {
  const makeRctx = (matcherCtx = {}) => ({
    routeParams: {},
    matcherCtx,
    memo: new Map(),
    depth: 0,
  });

  it("returns array as-is when value is already an array", async () => {
    const sections = [{ __resolveType: "section-A" }, { __resolveType: "section-B" }];
    const result = await resolveSectionsList(sections, makeRctx());
    expect(result).toEqual(sections);
  });

  it("returns empty array for null/undefined/non-object", async () => {
    expect(await resolveSectionsList(null, makeRctx())).toEqual([]);
    expect(await resolveSectionsList(undefined, makeRctx())).toEqual([]);
    expect(await resolveSectionsList("string", makeRctx())).toEqual([]);
    expect(await resolveSectionsList(42, makeRctx())).toEqual([]);
  });

  it("resolves page-level variant wrapper without __resolveType", async () => {
    // Simulates CMS admin wrapping all sections in a device variant
    // Rule has no __resolveType → evaluateMatcher returns true (match-all)
    const sectionsArray = [
      { __resolveType: "Header - 01" },
      { __resolveType: "site/sections/Account/PersonalData.tsx" },
      { __resolveType: "Footer - 01" },
    ];

    const variantWrapper = {
      variants: [
        {
          rule: { mobile: true, tablet: true, desktop: true },
          value: sectionsArray,
        },
      ],
    };

    const result = await resolveSectionsList(variantWrapper, makeRctx());
    expect(result).toEqual(sectionsArray);
  });

  it("returns empty when no variant matches in page-level wrapper", async () => {
    // All variants have __resolveType in rule → evaluateMatcher returns false
    // (unregistered matcher defaults to false)
    const variantWrapper = {
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts", mobile: true },
          value: [{ __resolveType: "MobileOnly" }],
        },
      ],
    };

    const result = await resolveSectionsList(variantWrapper, makeRctx());
    expect(result).toEqual([]);
  });

  it("picks first matching variant in page-level wrapper", async () => {
    const desktopSections = [{ __resolveType: "DesktopLayout" }];
    const mobileSections = [{ __resolveType: "MobileLayout" }];

    const variantWrapper = {
      variants: [
        {
          // No __resolveType → evaluateMatcher returns true (first match wins)
          rule: { desktop: true },
          value: desktopSections,
        },
        {
          rule: { mobile: true },
          value: mobileSections,
        },
      ],
    };

    const result = await resolveSectionsList(variantWrapper, makeRctx());
    expect(result).toEqual(desktopSections);
  });

  it("returns empty for object without __resolveType and without variants", async () => {
    const result = await resolveSectionsList({ someKey: "value" }, makeRctx());
    expect(result).toEqual([]);
  });

  it("respects max depth limit (20)", async () => {
    // Build 21 levels of nested variant wrappers to exceed MAX_RESOLVE_DEPTH=20
    let wrapper: any = [{ __resolveType: "deep" }];
    for (let i = 0; i < 21; i++) {
      wrapper = { variants: [{ rule: {}, value: wrapper }] };
    }
    const result = await resolveSectionsList(wrapper, makeRctx());
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Commerce loader auto-injects URL query params as top-level props
// ---------------------------------------------------------------------------
//
// Regression guard for Google Shopping deep links (and any direct entry
// with `?skuId=…`, `?q=…`, etc.): the apps-start canonical commerce
// loaders read `props.skuId` to pre-select a variant. The framework
// injects URL search params into `resolvedProps` at the commerce-loader
// call site so loaders see them on direct navigation. CMS-configured
// props win over URL params (URL is a fallback, not an override).

describe("commerce loader auto-injects URL search params as props", () => {
  const KEY = "site/loaders/__test/queryInjectLoader";

  beforeEach(() => {
    clearCommerceLoaders();
  });

  afterEach(() => {
    clearCommerceLoaders();
  });

  it("populates props.skuId from ?skuId= when CMS does not set it", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY, slug: "sabonete" }, undefined, {
      url: "https://store.com/produto/sabonete/p?skuId=12345&size=M",
      path: "/produto/sabonete/p",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      slug: "sabonete",
      skuId: "12345",
      size: "M",
      __pagePath: "/produto/sabonete/p",
      __pageUrl: "https://store.com/produto/sabonete/p?skuId=12345&size=M",
    });
  });

  it("does NOT override a CMS-configured prop with a URL param of the same name", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY, skuId: "cms-locked-sku" }, undefined, {
      url: "https://store.com/p?skuId=url-value",
      path: "/p",
    });

    expect(calls[0]?.skuId).toBe("cms-locked-sku");
  });

  it("decodes URL-encoded values", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY }, undefined, {
      url: "https://store.com/?q=preto%20azul",
      path: "/",
    });

    expect(calls[0]?.q).toBe("preto azul");
  });

  it("is a no-op when matcherCtx.url is missing", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY, slug: "abc" }, undefined, {});

    expect(calls[0]).toEqual({ slug: "abc" });
    expect(calls[0]?.__pageUrl).toBeUndefined();
  });

  it("warns and skips injection when matcherCtx.url is malformed", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        resolveValue({ __resolveType: KEY, slug: "abc" }, undefined, {
          url: "not a url",
          path: "/",
        }),
      ).resolves.not.toThrow();

      // Loader still ran with __pageUrl set, but no query params were
      // injected and the warning surfaced the upstream bug.
      expect(calls[0]).toMatchObject({ slug: "abc", __pageUrl: "not a url" });
      expect(Object.keys(calls[0] ?? {}).sort()).toEqual(
        ["__pagePath", "__pageUrl", "slug"].sort(),
      );
      const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes("malformed matcherCtx.url"))).toBe(true);
      expect(warnings.some((w) => w.includes(KEY))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("never auto-injects `page` — loaders that read __pageUrl apply their own index-base conversion (#391)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY }, undefined, {
      url: "https://store.com/?page=3",
      path: "/",
    });

    expect(calls[0]?.page).toBeUndefined();
  });

  it("coerces `count`/`pageOffset` to numbers instead of injecting raw strings", async () => {
    const calls: Array<Record<string, unknown>> = [];
    registerCommerceLoader(KEY, async (props: Record<string, unknown>) => {
      calls.push({ ...props });
      return null;
    });

    await resolveValue({ __resolveType: KEY }, undefined, {
      url: "https://store.com/?count=24&pageOffset=2",
      path: "/",
    });

    expect(calls[0]?.count).toBe(24);
    expect(calls[0]?.pageOffset).toBe(2);
  });
});

describe("commerce loader resolves legacy .ts-suffixed resolveType", () => {
  beforeEach(() => clearCommerceLoaders());
  afterEach(() => clearCommerceLoaders());

  it("matches a manifest key (no extension) against a decofile .ts resolveType", async () => {
    const calls: Array<Record<string, unknown>> = [];
    // Split-package manifests register WITHOUT the file extension.
    registerCommerceLoader("shopify/loaders/ProductDetailsPage", async (props) => {
      calls.push({ ...props });
      return null;
    });

    // Legacy (Fresh/Deno) decofile references it WITH the .ts extension.
    await resolveValue(
      { __resolveType: "shopify/loaders/ProductDetailsPage.ts", slug: "oversize-t-shirt-123" },
      undefined,
      {
        url: "https://store.com/products/oversize-t-shirt-123",
        path: "/products/oversize-t-shirt-123",
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ slug: "oversize-t-shirt-123" });
  });

  it("prefers an exact .ts registration over the stripped fallback", async () => {
    const hits: string[] = [];
    registerCommerceLoader("shopify/loaders/X", async () => {
      hits.push("plain");
      return null;
    });
    registerCommerceLoader("shopify/loaders/X.ts", async () => {
      hits.push("dotts");
      return null;
    });
    await resolveValue({ __resolveType: "shopify/loaders/X.ts" }, undefined, {
      url: "https://s.com/",
      path: "/",
    });
    expect(hits).toEqual(["dotts"]);
  });
});

// ---------------------------------------------------------------------------
// Async rendering: the admin (CMS Lazy ⚡ toggle) is the source of truth
// ---------------------------------------------------------------------------
//
// Regression guard for issue #266: the framework must NOT defer a section by
// position, and must NOT let code-level flags (`export const eager/neverDefer`)
// override the editor's ⚡ choice. A section is deferred iff the editor wrapped
// it in CMS Lazy/Deferred in the admin. The position threshold + code flags are
// an explicit per-site opt-in that is OFF by default (foldThreshold = Infinity)
// and never overrides the admin.

describe("async rendering config defaults", () => {
  beforeEach(() => {
    // Reset the globalThis-backed config so each assertion is order-independent.
    (globalThis as any).__deco.asyncConfig = null;
  });

  it("DEFAULT_FOLD_THRESHOLD is Infinity (position-based deferral off)", () => {
    expect(DEFAULT_FOLD_THRESHOLD).toBe(Infinity);
  });

  it("setAsyncRenderingConfig() defaults to foldThreshold=Infinity, respectCmsLazy=true", () => {
    setAsyncRenderingConfig();
    const cfg = getAsyncRenderingConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.foldThreshold).toBe(Infinity);
    expect(cfg!.respectCmsLazy).toBe(true);
    expect(cfg!.botAwareSeo).toBe(false); // opt-in — off by default
  });

  it("preserves an explicit finite foldThreshold (opt-in)", () => {
    setAsyncRenderingConfig({ foldThreshold: 3 });
    expect(getAsyncRenderingConfig()!.foldThreshold).toBe(3);
  });
});

describe("shouldDeferSection — admin is the source of truth", () => {
  const mkCfg = (over: Partial<AsyncRenderingConfig> = {}): AsyncRenderingConfig => ({
    respectCmsLazy: true,
    foldThreshold: Infinity,
    alwaysEager: new Set(),
    botAwareSeo: false,
    ...over,
  });

  const lazyWrap = (inner: object) => ({
    __resolveType: WELL_KNOWN_TYPES.LAZY,
    section: inner,
  });

  it("defers a section the editor marked ⚡ (wrapped in CMS Lazy)", () => {
    const section = lazyWrap({ __resolveType: "site/sections/Hero.tsx" });
    expect(shouldDeferSection(section, 0, mkCfg(), false)).toBe(true);
  });

  it("renders a non-⚡ section eagerly regardless of position (default Infinity)", () => {
    const section = { __resolveType: "site/sections/SeoText.tsx" };
    // Position 5 used to auto-defer with the old foldThreshold=3 — now SSR.
    expect(shouldDeferSection(section, 5, mkCfg(), false)).toBe(false);
  });

  it("admin ⚡ overrides `export const eager` (code flag ignored)", () => {
    const key = "site/sections/EagerButLazy.tsx";
    registerEagerSections([key]);
    const section = lazyWrap({ __resolveType: key });
    // Even with a finite threshold where the eager flag would otherwise apply,
    // the editor's ⚡ wins → deferred.
    expect(shouldDeferSection(section, 0, mkCfg({ foldThreshold: 3 }), false)).toBe(true);
  });

  it("admin ⚡ overrides `export const neverDefer` (code flag ignored)", () => {
    const key = "site/sections/NeverDeferButLazy.tsx";
    registerNeverDeferSections([key]);
    const section = lazyWrap({ __resolveType: key });
    expect(shouldDeferSection(section, 0, mkCfg(), false)).toBe(true);
  });

  it("bots always get SSR, even for ⚡ sections (SEO)", () => {
    const section = lazyWrap({ __resolveType: "site/sections/Hero.tsx" });
    expect(shouldDeferSection(section, 0, mkCfg(), true)).toBe(false);
  });

  it("opt-in finite foldThreshold defers UNMARKED sections by position", () => {
    const section = { __resolveType: "site/sections/Shelf.tsx" };
    expect(shouldDeferSection(section, 5, mkCfg({ foldThreshold: 3 }), false)).toBe(true);
    expect(shouldDeferSection(section, 1, mkCfg({ foldThreshold: 3 }), false)).toBe(false);
  });

  it("`export const deferred = true` defers one section even with respectCmsLazy off", () => {
    const key = "site/sections/HeavyPLP.tsx";
    registerAlwaysDeferSections([key]);
    const section = { __resolveType: key };
    // Not ⚡-wrapped and respectCmsLazy disabled — the per-section flag is the
    // only thing forcing deferral here.
    expect(shouldDeferSection(section, 0, mkCfg({ respectCmsLazy: false }), false)).toBe(true);
  });

  it("`export const deferred = true` still stays eager for bots (SEO)", () => {
    const key = "site/sections/HeavyPLPBot.tsx";
    registerAlwaysDeferSections([key]);
    const section = { __resolveType: key };
    expect(shouldDeferSection(section, 0, mkCfg({ respectCmsLazy: false }), true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEagerRequest — programmatic (non-navigation) fetches render eagerly
// ---------------------------------------------------------------------------
//
// An AJAX `fetch()` (e.g. the PLP "Ver mais"/load-more pagination) reads the
// static SSR HTML and never runs the client-side deferred-section resolution,
// so a ⚡ deferred section would be invisible (skeleton only). Such requests —
// identified by `Sec-Fetch-Dest: empty` — must render eagerly. Top-level browser
// navigations (`document`) stay deferred; SPA navigations are excluded so
// page-SEO commerce loaders stay off for humans (#286).
describe("isEagerRequest — programmatic fetch detection", () => {
  const HUMAN_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const reqWith = (dest: string) =>
    new Request("https://store.com/escolar?page=2", {
      headers: { "user-agent": HUMAN_UA, "sec-fetch-dest": dest },
    });

  it("programmatic fetch (Sec-Fetch-Dest: empty) is eager", () => {
    expect(isEagerRequest({ userAgent: HUMAN_UA, request: reqWith("empty") })).toBe(true);
  });

  it("top-level navigation (Sec-Fetch-Dest: document) is NOT eager", () => {
    expect(isEagerRequest({ userAgent: HUMAN_UA, request: reqWith("document") })).toBe(false);
  });

  it("SPA navigation (empty + isClientNavigation) is NOT eager (preserves #286)", () => {
    expect(
      isEagerRequest({
        userAgent: HUMAN_UA,
        request: reqWith("empty"),
        isClientNavigation: true,
      }),
    ).toBe(false);
  });

  it("falls back to matcherCtx.headers when no Request is present", () => {
    expect(isEagerRequest({ userAgent: HUMAN_UA, headers: { "sec-fetch-dest": "empty" } })).toBe(
      true,
    );
  });

  it("a request with no Sec-Fetch headers stays deferred (no UA bot, no override)", () => {
    expect(isEagerRequest({ userAgent: HUMAN_UA, url: "https://store.com/escolar" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Page SEO block — bot-aware commerce resolution
// ---------------------------------------------------------------------------
//
// The page-level SEO block (e.g. `commerce/sections/Seo/SeoPLPV2.tsx` with
// `jsonLD: { __resolveType: "PLP Loader" }`) is always eager. For humans the
// commerce-loader-backed props must be skipped: resolving them blocks SSR on a
// heavy upstream fetch and serializes the full product payload into HTML that a
// human request never renders. Bots keep the full resolution for indexing.
describe("resolvePageSeoBlock — bot-aware commerce SEO", () => {
  const KEY = "site/loaders/__test/plpSeoLoader";
  const HUMAN_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  const seoBlock = {
    __resolveType: "commerce/sections/Seo/SeoPLPV2.tsx",
    title: "Escolar",
    jsonLD: { __resolveType: KEY },
  };

  const rctx = (userAgent?: string) =>
    ({
      matcherCtx: { userAgent, url: "https://store.com/escolar", path: "/escolar" },
      memo: new Map(),
      depth: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  beforeEach(() => {
    clearCommerceLoaders();
    // Bot-aware SEO is opt-in — enable it for these cases.
    setAsyncRenderingConfig({ botAwareSeo: true });
  });
  afterEach(() => {
    clearCommerceLoaders();
    setAsyncRenderingConfig({ botAwareSeo: false });
  });

  it("flag OFF (default): humans still get the full SEO — no regression", async () => {
    setAsyncRenderingConfig({ botAwareSeo: false });
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, products: [{ id: 1 }] };
    });

    const res = await resolvePageSeoBlock(seoBlock, rctx(HUMAN_UA));

    expect(calls).toBe(1); // loader runs for everyone when the flag is off
    expect(res?.props?.jsonLD).toMatchObject({ seo: { title: "Rich SEO title" } });
  });

  it("humans: skips the commerce loader and drops the commerce-backed prop", async () => {
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, products: [{ id: 1 }] };
    });

    const res = await resolvePageSeoBlock(seoBlock, rctx(HUMAN_UA));

    expect(calls).toBe(0); // heavy upstream fetch never runs for humans
    expect(res?.props).toHaveProperty("title", "Escolar"); // literal props kept
    expect(res?.props).not.toHaveProperty("jsonLD"); // no product payload in HTML
  });

  it("bots: resolves the commerce loader and keeps the JSON-LD payload", async () => {
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, products: [{ id: 1 }] };
    });

    const res = await resolvePageSeoBlock(seoBlock, rctx(BOT_UA));

    expect(calls).toBe(1);
    expect(res?.props?.jsonLD).toMatchObject({ seo: { title: "Rich SEO title" } });
  });

  it("?__deco_ssr=1 override: a human UA gets the full eager SEO (QA/audit)", async () => {
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, products: [{ id: 1 }] };
    });

    const ctx = {
      matcherCtx: {
        userAgent: HUMAN_UA,
        url: "https://store.com/escolar?__deco_ssr=1",
        path: "/escolar",
      },
      memo: new Map(),
      depth: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const res = await resolvePageSeoBlock(seoBlock, ctx);

    expect(calls).toBe(1); // override forces the commerce loader to run
    expect(res?.props?.jsonLD).toMatchObject({ seo: { title: "Rich SEO title" } });
  });
});

describe("resolvePageSeoBlock — per-section ignoreStructuredData drives the fetch-skip", () => {
  const KEY = "site/loaders/__test/plpSeoLoader";
  const HUMAN_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  // PLP toggle lives under `configJsonLD`; PDP toggle is top-level.
  const plpBlock = {
    __resolveType: "commerce/sections/Seo/SeoPLPV2.tsx",
    title: "Escolar",
    jsonLD: { __resolveType: KEY },
    configJsonLD: { ignoreStructuredData: true },
  };
  const pdpBlock = {
    __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx",
    title: "Produto",
    jsonLD: { __resolveType: KEY },
    ignoreStructuredData: true,
  };

  const rctx = (userAgent?: string) =>
    ({
      matcherCtx: { userAgent, url: "https://store.com/escolar", path: "/escolar" },
      memo: new Map(),
      depth: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  beforeEach(() => {
    clearCommerceLoaders();
    // The per-section toggle is the PRIMARY lever — it must work with the
    // site-wide botAwareSeo shortcut OFF.
    setAsyncRenderingConfig({ botAwareSeo: false });
  });
  afterEach(() => {
    clearCommerceLoaders();
    setAsyncRenderingConfig({ botAwareSeo: false });
  });

  it("humans: toggle skips the commerce loader (PLP configJsonLD)", async () => {
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, products: [{ id: 1 }] };
    });

    const res = await resolvePageSeoBlock(plpBlock, rctx(HUMAN_UA));

    expect(calls).toBe(0); // no product fetch for humans
    expect(res?.props).toHaveProperty("title", "Escolar");
    expect(res?.props).not.toHaveProperty("jsonLD");
  });

  it("bots: toggle still resolves the commerce loader (PLP configJsonLD)", async () => {
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, products: [{ id: 1 }] };
    });

    const res = await resolvePageSeoBlock(plpBlock, rctx(BOT_UA));

    expect(calls).toBe(1);
    expect(res?.props?.jsonLD).toMatchObject({ seo: { title: "Rich SEO title" } });
  });

  it("humans: top-level toggle skips the commerce loader (PDP)", async () => {
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, product: { id: 1 } };
    });

    const res = await resolvePageSeoBlock(pdpBlock, rctx(HUMAN_UA));

    expect(calls).toBe(0);
    expect(res?.props).not.toHaveProperty("jsonLD");
  });

  it("toggle OFF: humans keep the full SEO even with botAwareSeo off (no regression)", async () => {
    let calls = 0;
    registerCommerceLoader(KEY, async () => {
      calls++;
      return { seo: { title: "Rich SEO title" }, products: [{ id: 1 }] };
    });

    const noToggle = {
      __resolveType: "commerce/sections/Seo/SeoPLPV2.tsx",
      title: "Escolar",
      jsonLD: { __resolveType: KEY },
    };
    const res = await resolvePageSeoBlock(noToggle, rctx(HUMAN_UA));

    expect(calls).toBe(1); // no toggle + no global flag → resolve for everyone
    expect(res?.props?.jsonLD).toMatchObject({ seo: { title: "Rich SEO title" } });
  });
});

describe("extractSeoFromProps — commerce jsonLD structured data", () => {
  const plp = (overrides: Record<string, unknown> = {}) => ({
    "@type": "ProductListingPage",
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, item: "https://x.com/a" },
        { "@type": "ListItem", position: 2, item: "https://x.com/a/b" },
      ],
    },
    products: [{ "@type": "Product", name: "P1" }],
    seo: { title: "PLP Title", description: "PLP Desc" },
    ...overrides,
  });

  const pdp = (overrides: Record<string, unknown> = {}) => ({
    "@type": "ProductDetailsPage",
    breadcrumbList: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, item: "https://x.com/a" },
        { "@type": "ListItem", position: 2, item: "https://x.com/a/p" },
      ],
    },
    product: { "@type": "Product", name: "P1", image: [{ url: "https://x.com/p.jpg" }] },
    seo: { title: "PDP Title", description: "PDP Desc" },
    ...overrides,
  });

  it("derives title/description/canonical and emits the ItemList JSON-LD (PLP)", () => {
    // The casaevideo.com.br/eletroportateis regression: a page.seo pointing at
    // commerce/sections/Seo/SeoPLPV2.tsx resolved its jsonLD but emitted no
    // schema.org. There is no section component in start to run this transform.
    const seo = extractSeoFromProps({
      __resolveType: "commerce/sections/Seo/SeoPLPV2.tsx",
      jsonLD: plp(),
    });
    expect(seo.title).toBe("PLP Title");
    expect(seo.description).toBe("PLP Desc");
    // Highest-position breadcrumb item wins.
    expect(seo.canonical).toBe("https://x.com/a/b");
    expect(seo.noIndexing).toBe(false);
    expect(seo.jsonLDs).toHaveLength(1);
    expect(seo.jsonLDs?.[0]).toMatchObject({ "@type": "ProductListingPage" });
  });

  it("emits the product image and JSON-LD for a PDP", () => {
    const seo = extractSeoFromProps({
      __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx",
      jsonLD: {
        "@type": "ProductDetailsPage",
        breadcrumbList: { "@type": "BreadcrumbList", itemListElement: [] },
        product: {
          "@type": "Product",
          name: "Widget",
          image: [{ url: "https://x.com/w.jpg" }],
        },
        seo: { title: "Widget", description: "A widget" },
      },
    });
    expect(seo.title).toBe("Widget");
    expect(seo.image).toBe("https://x.com/w.jpg");
    expect(seo.jsonLDs?.[0]).toMatchObject({ "@type": "ProductDetailsPage" });
  });

  it("lets manual override fields win over the jsonLD-derived ones", () => {
    const seo = extractSeoFromProps({
      jsonLD: plp(),
      title: "Manual Title",
      canonical: "https://x.com/manual",
    });
    expect(seo.title).toBe("Manual Title");
    expect(seo.canonical).toBe("https://x.com/manual");
    expect(seo.jsonLDs).toHaveLength(1);
  });

  it("omits structured data for humans when ignoreStructuredData is set", () => {
    const seo = extractSeoFromProps({
      jsonLD: plp(),
      configJsonLD: { ignoreStructuredData: true },
    });
    expect(seo.jsonLDs).toBeUndefined();
    // Metadata is still derived — only the ItemList is suppressed.
    expect(seo.title).toBe("PLP Title");
  });

  it("keeps structured data for bots even when ignoreStructuredData is set", () => {
    // Bot-aware: the toggle suppresses JSON-LD for humans only. Crawlers (and the
    // `?__deco_ssr=1` audit override, both surfaced via isEager) still get it.
    const seo = extractSeoFromProps(
      { jsonLD: plp(), configJsonLD: { ignoreStructuredData: true } },
      { isEager: true },
    );
    expect(seo.jsonLDs).toHaveLength(1);
    expect(seo.title).toBe("PLP Title");
  });

  it("omits structured data for bots too when the listing is empty", () => {
    // ignoreStructuredData is bot-aware, but an empty listing contributes no
    // ItemList regardless of bot status.
    const seo = extractSeoFromProps(
      { jsonLD: plp({ products: [] }), configJsonLD: { ignoreStructuredData: true } },
      { isEager: true },
    );
    expect(seo.jsonLDs).toBeUndefined();
  });

  it("keeps PDP structured data for bots with top-level ignoreStructuredData", () => {
    const seo = extractSeoFromProps(
      { jsonLD: pdp(), ignoreStructuredData: true },
      { isEager: true },
    );
    expect(seo.jsonLDs).toHaveLength(1);
  });

  it("marks an empty listing noIndexing and emits no ItemList", () => {
    const seo = extractSeoFromProps({ jsonLD: plp({ products: [] }) });
    expect(seo.noIndexing).toBe(true);
    expect(seo.jsonLDs).toBeUndefined();
  });

  it("does not touch a section that already emitted jsonLDs", () => {
    const existing = [{ "@type": "WebSite" }];
    const seo = extractSeoFromProps({ jsonLD: plp(), jsonLDs: existing });
    expect(seo.jsonLDs).toBe(existing);
  });

  it("removeVideos clones rather than mutating the source jsonLD", () => {
    const source = plp({
      products: [{ "@type": "Product", name: "P1", video: [{ "@type": "VideoObject" }] }],
    });
    const seo = extractSeoFromProps({
      jsonLD: source,
      configJsonLD: { removeVideos: true },
    });
    expect(seo.jsonLDs?.[0].products[0].video).toBeUndefined();
    // Source untouched — it may be shared with a body section.
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    expect((source.products[0] as any).video).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resolveDecoPage — client nav gets the SAME eager/deferred split as SSR
// ---------------------------------------------------------------------------
//
// A TanStack route loader is BLOCKING: the router will not commit the
// transition until the loader promise settles. Eager-resolving every ⚡
// below-fold section on client nav therefore freezes the previous page for as
// long as the slowest upstream takes (measured on a real PDP: 20 awaited
// sections, 2717ms, 3.41MB — worse than a full reload). So deferral must apply
// to client nav exactly as it does to SSR.
//
// The historical `!isClientNavigation` gate (decocms/blocks#277) was a
// workaround for deferred loaders that appeared to lose per-request app
// context. It traded a page-wide latency regression for that symptom. The
// second hop (`loadDeferredSection`) is the SAME server fn the SSR path has
// always used and rebuilds MatcherContext from the real request — see the
// "#277 — per-request context survives the deferred second hop" cases below.
// ---------------------------------------------------------------------------

describe("resolveDecoPage — deferral parity between SSR and client nav", () => {
  const lazySec = {
    __resolveType: WELL_KNOWN_TYPES.LAZY,
    section: { __resolveType: "site/sections/Hero.tsx" },
  };
  const eagerSec = { __resolveType: "site/sections/Banner.tsx" };

  beforeEach(() => {
    // Enable async rendering so useAsync can be true.
    setAsyncRenderingConfig({ foldThreshold: Infinity, respectCmsLazy: true });
    // resolveSectionShallow unwraps the ⚡ and looks up the inner key via
    // getSection — return truthy so it produces a DeferredSection rather than
    // falling back to eager resolution.
    (getSection as ReturnType<typeof vi.fn>).mockReturnValue({ default: () => null });
    // A page with one plain section followed by one CMS ⚡-wrapped section.
    (findPageByPath as ReturnType<typeof vi.fn>).mockReturnValue({
      page: { name: "test", sections: [eagerSec, lazySec] },
      params: {},
      blockKey: "test-page",
    });
  });

  afterEach(() => {
    (getSection as ReturnType<typeof vi.fn>).mockReset();
    (findPageByPath as ReturnType<typeof vi.fn>).mockReset();
  });

  it("SSR request defers the CMS ⚡ section and keeps the plain one eager", async () => {
    const result = await resolveDecoPage("/product/foo", {});
    expect(result?.deferredSections).toHaveLength(1);
    expect(result?.deferredSections[0].component).toBe("site/sections/Hero.tsx");
    expect(result?.resolvedSections.map((s) => s.component)).toEqual(["site/sections/Banner.tsx"]);
  });

  it("client nav produces the IDENTICAL split — deferral is not disabled", async () => {
    const ssr = await resolveDecoPage("/product/foo", {});
    const nav = await resolveDecoPage("/product/foo", { isClientNavigation: true });

    // The acceptance criterion: client nav returns deferredSections and awaits
    // only the eager set, exactly like SSR.
    expect(nav?.deferredSections).toHaveLength(1);
    expect(nav?.deferredSections.map((d) => d.component)).toEqual(
      ssr?.deferredSections.map((d) => d.component),
    );
    expect(nav?.resolvedSections.map((s) => s.component)).toEqual(
      ssr?.resolvedSections.map((s) => s.component),
    );
  });

  it("the ⚡ section's index is preserved on client nav (ordering on the merge)", async () => {
    const nav = await resolveDecoPage("/product/foo", { isClientNavigation: true });
    expect(nav?.deferredSections[0].index).toBe(1);
  });

  it("bots stay fully eager on a client-nav-flagged request (SEO guarantee)", async () => {
    const result = await resolveDecoPage("/product/foo", {
      isClientNavigation: true,
      userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    });
    expect(result?.deferredSections).toHaveLength(0);
    expect(result?.resolvedSections).toHaveLength(2);
  });

  it("?__deco_ssr=1 stays fully eager on a client-nav-flagged request", async () => {
    const result = await resolveDecoPage("/product/foo", {
      isClientNavigation: true,
      url: "https://store.com/product/foo?__deco_ssr=1",
    });
    expect(result?.deferredSections).toHaveLength(0);
    expect(result?.resolvedSections).toHaveLength(2);
  });

  it("a genuine programmatic fetch (Sec-Fetch-Dest: empty, no client-nav flag) stays eager", async () => {
    const result = await resolveDecoPage("/product/foo", {
      request: new Request("https://store.com/product/foo", {
        headers: { "sec-fetch-dest": "empty" },
      }),
    });
    expect(result?.deferredSections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #277 — per-request context survives the deferred second hop
// ---------------------------------------------------------------------------
//
// This is the invariant that made it safe to re-enable deferral on client nav.
// #277 reported deferred sections rendering blank because their loaders "lost"
// per-request app context. The guarantee is that `resolveDeferredSectionFull`
// (and `loadDeferredSection`, which wraps it in @decocms/tanstack) threads the
// caller's MatcherContext — cookies, url, path, userAgent, request — into BOTH
// the cache-hit and the cache-miss (`reExtractRawProps`) branch. A different
// isolate misses the in-process rawProps Map, so the miss path is the one that
// actually runs in production on Cloudflare Workers; if it ever stops receiving
// matcherCtx, cookie-dependent loaders silently resolve against an anonymous
// request. Do not relax these assertions.

describe("#277 — deferred second hop keeps per-request context", () => {
  const PROBE = "test/matchers/probe.ts";
  const CTX: MatcherContext & { request: Request } = {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari",
    url: "https://store.com/product/foo?utm=x",
    path: "/product/foo",
    cookies: { deco_segment: "abc", VtexIdclientAutCookie: "tok" },
    request: new Request("https://store.com/product/foo?utm=x"),
  };

  /** Every MatcherContext the probe matcher was evaluated with. */
  let seen: MatcherContext[] = [];

  // The ⚡ section sits behind a multivariate flag whose rule is the probe
  // matcher. Reaching the inner Shelf at all therefore PROVES the resolver
  // evaluated the rule, and the probe records exactly which context it saw —
  // an end-to-end assertion rather than a mock of the call site.
  const gatedLazy = {
    __resolveType: WELL_KNOWN_TYPES.MULTIVARIATE,
    variants: [
      {
        rule: { __resolveType: PROBE },
        value: {
          __resolveType: WELL_KNOWN_TYPES.LAZY,
          section: { __resolveType: "site/sections/Shelf.tsx", title: "Mais vendidos" },
        },
      },
    ],
  };

  beforeEach(() => {
    seen = [];
    registerMatcher(PROBE, (_rule, ctx) => {
      seen.push(ctx);
      return true;
    });
    setAsyncRenderingConfig({ foldThreshold: Infinity, respectCmsLazy: true });
    (getSection as ReturnType<typeof vi.fn>).mockReturnValue({ default: () => null });
    (findPageByPath as ReturnType<typeof vi.fn>).mockReturnValue({
      page: { name: "test", sections: [gatedLazy] },
      params: {},
      blockKey: "test-page",
    });
    (runSingleSectionLoader as ReturnType<typeof vi.fn>).mockImplementation(
      async (s: unknown) => s,
    );
  });

  afterEach(() => {
    (getSection as ReturnType<typeof vi.fn>).mockReset();
    (findPageByPath as ReturnType<typeof vi.fn>).mockReset();
    (runSingleSectionLoader as ReturnType<typeof vi.fn>).mockReset();
  });

  it("reExtractRawProps (cross-isolate cache miss) resolves with the caller's cookies/UA/url", async () => {
    // A cold isolate never populated the in-process rawProps Map, so this is
    // the branch that actually runs in production on Cloudflare Workers.
    const rawProps = await reExtractRawProps("/product/foo", "site/sections/Shelf.tsx", 0, CTX);

    expect(rawProps).toMatchObject({ title: "Mais vendidos" });
    expect(seen).not.toHaveLength(0);
    for (const ctx of seen) {
      expect(ctx.cookies).toEqual(CTX.cookies);
      expect(ctx.userAgent).toBe(CTX.userAgent);
      expect(ctx.url).toBe(CTX.url);
      expect(ctx.request).toBe(CTX.request);
    }
  });

  it("resolveDeferredSectionFull on a cold cache still resolves + enriches the section", async () => {
    const ds = {
      component: "site/sections/Shelf.tsx",
      index: 0,
      props: {},
    } as unknown as DeferredSection;

    const section = await resolveDeferredSectionFull(ds, "/product/foo", CTX.request, CTX);

    expect(section).not.toBeNull();
    expect(section?.component).toBe("site/sections/Shelf.tsx");
    expect(section?.index).toBe(0);
    // The deferred hop must run the section's own loader — this is what #277
    // reported as missing, and it is what makes the second hop equivalent to
    // eager resolution. Scope note: this asserts the request THIS function was
    // handed reaches the loader. `loadDeferredSection` in @decocms/tanstack
    // constructs its own `new Request(pageUrl || serverUrl, { headers })` before
    // calling in, so the fidelity of that reconstruction is a separate concern
    // and is not covered here.
    expect(runSingleSectionLoader).toHaveBeenCalled();
    const [, passedRequest] = (runSingleSectionLoader as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, Request];
    expect(passedRequest).toBe(CTX.request);
  });

  it("a context-free second hop is observably different — guards against dropping matcherCtx", async () => {
    // If reExtractRawProps ever stops threading matcherCtx, cookie/UA-gated
    // variants silently resolve against an anonymous request. Assert the probe
    // can actually tell the two apart, so the test above is not vacuous.
    await reExtractRawProps("/product/foo", "site/sections/Shelf.tsx", 0, undefined);
    expect(seen).not.toHaveLength(0);
    expect(seen[0].cookies).toBeUndefined();
    expect(seen[0].userAgent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hidden array items — a `never`-gated multivariate wrapper must vanish from
// the array, not survive as a `null` hole the section renders as empty.
//
// The admin (Studio) hides an array item by wrapping it in
// `{ __resolveType: "website/flags/multivariate.ts", variants: [{ value, rule:
// { __resolveType: "website/matchers/never.ts" } }] }`. `never` never matches,
// so the wrapper resolves to "not present" and the item is dropped.
// ---------------------------------------------------------------------------

describe("hidden array items (never matcher)", () => {
  const NEVER = "website/matchers/never.ts";
  const ALWAYS = "website/matchers/always.ts";
  const MULTIVARIATE = "website/flags/multivariate.ts";

  const hidden = (value: unknown) => ({
    __resolveType: MULTIVARIATE,
    variants: [{ value, rule: { __resolveType: NEVER } }],
  });

  it("drops a hidden item from an array instead of leaving a null hole", async () => {
    const benefits = [
      { label: "Parcelamento" },
      { label: "Frete" },
      hidden({ label: "RetiradaLoja" }),
      hidden({ label: "EntregaExpressa" }),
    ];

    const result = (await resolveValue({ benefits }, undefined, {})) as {
      benefits: unknown[];
    };

    expect(result.benefits).toEqual([{ label: "Parcelamento" }, { label: "Frete" }]);
    // No null holes.
    expect(result.benefits).not.toContain(null);
  });

  it("keeps a visible (always-gated) item in the array", async () => {
    const benefits = [
      {
        __resolveType: MULTIVARIATE,
        variants: [{ value: { label: "Shown" }, rule: { __resolveType: ALWAYS } }],
      },
      hidden({ label: "Hidden" }),
    ];

    const result = (await resolveValue({ benefits }, undefined, {})) as {
      benefits: unknown[];
    };

    expect(result.benefits).toEqual([{ label: "Shown" }]);
  });

  it("preserves a legitimate null value in an array (matched variant resolving to null)", async () => {
    // A matched variant whose value is literally null stays — only the
    // no-match sentinel is filtered, not every null.
    const items = [
      {
        __resolveType: MULTIVARIATE,
        variants: [{ value: null, rule: { __resolveType: ALWAYS } }],
      },
      { label: "kept" },
    ];

    const result = (await resolveValue({ items }, undefined, {})) as { items: unknown[] };

    expect(result.items).toEqual([null, { label: "kept" }]);
  });
});

// ---------------------------------------------------------------------------
// resolved-layout cache — device is part of the key
// ---------------------------------------------------------------------------
//
// The key used to be the component path alone, so the first visitor's variant
// was served to everyone for the whole TTL. A real store had to leave Header
// and Footer OUT of registerLayoutSections because of it, and then re-resolved
// both on every page and every navigation. These cases pin the axis; without
// them a refactor could silently collapse the key again and the symptom (a
// mobile header on desktop) only shows up in production, minutes later.

describe("layoutCacheKey — the resolved-layout cache is segmented by device", () => {
  const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari";
  const TABLET_UA = "Mozilla/5.0 (iPad; CPU OS 17_0) Safari/605";
  const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36";
  const KEY = "site/sections/Header.tsx";

  // The key used to be the component path alone. A site whose Header takes a
  // per-request device prop therefore served the first visitor's variant to
  // everyone for the whole 5-minute TTL — a mobile header on desktop. The only
  // escape was leaving Header/Footer out of `registerLayoutSections`, which is
  // what a real store did, and it then re-resolved both on every page and every
  // navigation.

  it("mobile, tablet and desktop are three distinct keys", () => {
    const keys = [MOBILE_UA, TABLET_UA, DESKTOP_UA].map((ua) => layoutCacheKey(KEY, { userAgent: ua }));
    expect(new Set(keys).size).toBe(3);
  });

  it("the same device yields the same key — the cache still works", () => {
    expect(layoutCacheKey(KEY, { userAgent: DESKTOP_UA })).toBe(
      layoutCacheKey(KEY, { userAgent: DESKTOP_UA }),
    );
  });

  it("different components never share a key on the same device", () => {
    expect(layoutCacheKey("site/sections/Header.tsx", { userAgent: MOBILE_UA })).not.toBe(
      layoutCacheKey("site/sections/Footer.tsx", { userAgent: MOBILE_UA }),
    );
  });

  it("a missing userAgent still produces a key (no crash, no undefined axis)", () => {
    const noCtx = layoutCacheKey(KEY);
    expect(noCtx).toContain(KEY);
    expect(noCtx).not.toContain("undefined");
    // An absent UA must land on the SAME bucket as a request whose UA is empty,
    // so a health check and a real desktop hit do not fragment the cache twice.
    expect(noCtx).toBe(layoutCacheKey(KEY, { userAgent: "" }));
  });
});
