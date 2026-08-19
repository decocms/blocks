import { beforeEach, describe, expect, it, vi } from "vitest";

const { onChangeListeners } = vi.hoisted(() => ({
  onChangeListeners: [] as Array<() => void>,
}));

vi.mock("@decocms/blocks/cms", () => ({
  loadBlocks: vi.fn(),
  onChange: vi.fn((listener: () => void) => {
    onChangeListeners.push(listener);
  }),
  resolvePageSections: vi.fn(),
}));

import { loadBlocks, resolvePageSections } from "@decocms/blocks/cms";
import {
  __resetSiteGlobalsCache,
  dedupeGlobals,
  resolveSiteGlobals,
  siteGlobalsCacheKey,
  withSiteGlobals,
} from "./withSiteGlobals";

const mockedLoadBlocks = loadBlocks as unknown as ReturnType<typeof vi.fn>;
const mockedResolvePageSections = resolvePageSections as unknown as ReturnType<typeof vi.fn>;

describe("withSiteGlobals", () => {
  beforeEach(() => {
    __resetSiteGlobalsCache();
    mockedLoadBlocks.mockReset();
    mockedResolvePageSections.mockReset();
  });

  describe("resolveSiteGlobals", () => {
    it("returns empty when there is no Site block", async () => {
      mockedLoadBlocks.mockReturnValue({});
      const result = await resolveSiteGlobals();
      expect(result.resolvedSections).toEqual([]);
      expect(result.rawRefs).toEqual([]);
      expect(mockedResolvePageSections).not.toHaveBeenCalled();
    });

    it("returns empty when Site block has no globals", async () => {
      mockedLoadBlocks.mockReturnValue({ site: { seo: { title: "x" } } });
      const result = await resolveSiteGlobals();
      expect(result.resolvedSections).toEqual([]);
      expect(result.rawRefs).toEqual([]);
      expect(mockedResolvePageSections).not.toHaveBeenCalled();
    });

    it("gathers theme + global + pageSections in order", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: {
          theme: { __resolveType: "Theme" },
          global: [{ __resolveType: "Analytics" }, { __resolveType: "WishlistProvider" }],
          pageSections: [{ __resolveType: "Session" }],
        },
      });
      const resolved = [
        { component: "Theme.tsx", props: {}, key: "k0" },
        { component: "Analytics.tsx", props: {}, key: "k1" },
        { component: "Wishlist.tsx", props: {}, key: "k2" },
        { component: "Session.tsx", props: {}, key: "k3" },
      ];
      mockedResolvePageSections.mockResolvedValue(resolved);

      const result = await resolveSiteGlobals();

      expect(result.rawRefs).toEqual([
        { __resolveType: "Theme" },
        { __resolveType: "Analytics" },
        { __resolveType: "WishlistProvider" },
        { __resolveType: "Session" },
      ]);
      expect(result.resolvedSections).toEqual(resolved);
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("accepts both `site` (lowercase) and `Site` (PascalCase) block keys", async () => {
      mockedLoadBlocks.mockReturnValue({
        Site: { theme: { __resolveType: "Theme" } },
      });
      mockedResolvePageSections.mockResolvedValue([
        { component: "Theme.tsx", props: {}, key: "k0" },
      ]);
      const result = await resolveSiteGlobals();
      expect(result.rawRefs).toEqual([{ __resolveType: "Theme" }]);
      expect(result.resolvedSections).toHaveLength(1);
    });

    it("dedupes inflight requests (single resolvePageSections call for parallel callers)", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      let resolveFn!: (v: unknown[]) => void;
      mockedResolvePageSections.mockImplementation(
        () =>
          new Promise((res) => {
            resolveFn = res as any;
          }),
      );

      const a = resolveSiteGlobals();
      const b = resolveSiteGlobals();
      resolveFn([{ component: "A.tsx", props: {}, key: "k0" }]);
      const [ra, rb] = await Promise.all([a, b]);

      expect(ra).toEqual(rb);
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("caches across calls within TTL", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      mockedResolvePageSections.mockResolvedValue([{ component: "A.tsx", props: {}, key: "k0" }]);

      await resolveSiteGlobals();
      await resolveSiteGlobals();
      await resolveSiteGlobals();

      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("invalidates cache when onChange fires", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      mockedResolvePageSections.mockResolvedValue([{ component: "A.tsx", props: {}, key: "k0" }]);

      await resolveSiteGlobals();
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);

      // Simulate a CMS reload
      for (const listener of onChangeListeners) listener();

      await resolveSiteGlobals();
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(2);
    });

    it("does not cache failures (next call retries)", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Analytics" }] },
      });
      mockedResolvePageSections
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce([{ component: "A.tsx", props: {}, key: "k0" }]);

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const first = await resolveSiteGlobals();
      expect(first.resolvedSections).toEqual([]);

      const second = await resolveSiteGlobals();
      expect(second.resolvedSections).toHaveLength(1);
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(2);
      errSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Matcher context (#3)
  //
  // Global sections can hold URL-dependent variants — the multivariate
  // Alerta/topbar block lives in `site.global`. Resolving without a matcher
  // context, or caching by path alone, silently collapses those variants.
  // -------------------------------------------------------------------------

  describe("matcher context", () => {
    function siteWithGlobal() {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Alerta" }] },
      });
      mockedResolvePageSections.mockResolvedValue([{ component: "Alerta.tsx", props: {}, key: "k0" }]);
    }

    const farmCtx = {
      path: "/vestido/p",
      url: "https://www.farmrio.com.br/vestido/p?brand=farm",
    };
    const etcCtx = {
      path: "/vestido/p",
      url: "https://www.farmrio.com.br/vestido/p?brand=farmetc",
    };

    it("forwards the matcher context to resolvePageSections", async () => {
      siteWithGlobal();
      await resolveSiteGlobals(etcCtx);
      expect(mockedResolvePageSections).toHaveBeenCalledWith(
        [{ __resolveType: "Alerta" }],
        etcCtx,
      );
    });

    it("does NOT share a cache entry between same path + different query", async () => {
      siteWithGlobal();

      // Cold path, ETC first — pre-fix this poisoned the entry for both URLs.
      await resolveSiteGlobals(etcCtx);
      await resolveSiteGlobals(farmCtx);

      expect(mockedResolvePageSections).toHaveBeenCalledTimes(2);
      expect(mockedResolvePageSections).toHaveBeenNthCalledWith(1, expect.anything(), etcCtx);
      expect(mockedResolvePageSections).toHaveBeenNthCalledWith(2, expect.anything(), farmCtx);
    });

    it("shares one cache entry for the identical path + query", async () => {
      siteWithGlobal();
      await resolveSiteGlobals(etcCtx);
      await resolveSiteGlobals({ ...etcCtx });
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("treats param order as irrelevant (sorted key)", async () => {
      siteWithGlobal();
      await resolveSiteGlobals({ path: "/p", url: "https://x.com/p?a=1&b=2" });
      await resolveSiteGlobals({ path: "/p", url: "https://x.com/p?b=2&a=1" });
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("does not fragment the cache across utm_* variants", async () => {
      siteWithGlobal();
      await resolveSiteGlobals({ path: "/p", url: "https://x.com/p?brand=farmetc" });
      await resolveSiteGlobals({
        path: "/p",
        url: "https://x.com/p?brand=farmetc&utm_source=google&gclid=xyz",
      });
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
    });

    it("separates different paths", async () => {
      siteWithGlobal();
      await resolveSiteGlobals({ path: "/a", url: "https://x.com/a" });
      await resolveSiteGlobals({ path: "/b", url: "https://x.com/b" });
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(2);
    });

    it("keeps the no-context call on its own key (back-compat)", async () => {
      siteWithGlobal();
      await resolveSiteGlobals();
      await resolveSiteGlobals();
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(1);
      expect(mockedResolvePageSections).toHaveBeenCalledWith([{ __resolveType: "Alerta" }], undefined);
    });

    it("dedups concurrent in-flight calls per key, not globally", async () => {
      mockedLoadBlocks.mockReturnValue({
        site: { global: [{ __resolveType: "Alerta" }] },
      });
      mockedResolvePageSections.mockImplementation(async (_refs: unknown, ctx: any) => [
        { component: "Alerta.tsx", props: { brand: new URL(ctx.url).searchParams.get("brand") }, key: "k0" },
      ]);

      const [etc, farm, etcAgain] = await Promise.all([
        resolveSiteGlobals(etcCtx),
        resolveSiteGlobals(farmCtx),
        resolveSiteGlobals(etcCtx),
      ]);

      expect(etc.resolvedSections[0].props).toEqual({ brand: "farmetc" });
      expect(farm.resolvedSections[0].props).toEqual({ brand: "farm" });
      expect(etcAgain).toBe(etc);
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(2);
    });

    it("evicts old keys instead of growing without bound", async () => {
      siteWithGlobal();
      // CACHE_MAX_ENTRIES is 64 — walk well past it, then re-request the first.
      for (let i = 0; i < 80; i++) {
        await resolveSiteGlobals({ path: "/p", url: `https://x.com/p?i=${i}` });
      }
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(80);

      await resolveSiteGlobals({ path: "/p", url: "https://x.com/p?i=0" });
      expect(mockedResolvePageSections).toHaveBeenCalledTimes(81); // key 0 was evicted
    });
  });

  describe("siteGlobalsCacheKey", () => {
    it("is empty for no context", () => {
      expect(siteGlobalsCacheKey()).toBe("");
    });

    it("starts with the path alone when there is no query", () => {
      expect(siteGlobalsCacheKey({ path: "/p", url: "https://x.com/p" })).toBe("/p|desktop|");
      expect(siteGlobalsCacheKey({ path: "/p" })).toBe("/p|desktop|");
    });

    it("includes sorted, tracking-free query params", () => {
      expect(siteGlobalsCacheKey({ path: "/p", url: "https://x.com/p?b=2&utm_source=g&a=1" })).toBe(
        "/p?a=1&b=2|desktop|",
      );
    });

    it("distinguishes brand=farm from brand=farmetc", () => {
      expect(siteGlobalsCacheKey({ path: "/x/p", url: "https://x.com/x/p?brand=farm" })).not.toBe(
        siteGlobalsCacheKey({ path: "/x/p", url: "https://x.com/x/p?brand=farmetc" }),
      );
    });

    it("distinguishes device class", () => {
      const mobile = siteGlobalsCacheKey({
        path: "/p",
        url: "https://x.com/p",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
      });
      expect(mobile).not.toBe(siteGlobalsCacheKey({ path: "/p", url: "https://x.com/p" }));
    });

    it("distinguishes the sticky-flag segment cohort", () => {
      expect(
        siteGlobalsCacheKey({ path: "/p", url: "https://x.com/p", cookies: { deco_segment: "a" } }),
      ).not.toBe(
        siteGlobalsCacheKey({ path: "/p", url: "https://x.com/p", cookies: { deco_segment: "b" } }),
      );
    });

    it("falls back to the path for an unparseable url", () => {
      expect(siteGlobalsCacheKey({ path: "/p", url: "::::" })).toBe("/p|desktop|");
    });
  });

  describe("withSiteGlobals (deprecated no-op)", () => {
    // Site globals merging moved into the `loadCmsPage` server function so SSR
    // and SPA navigations both go through the same server-side path (#233).
    // The wrapper is now a passthrough kept only for backward compatibility.
    it("is an identity wrapper — returns the route config unchanged", () => {
      const baseLoader = vi.fn().mockResolvedValue({ resolvedSections: [] });
      const input = { loader: baseLoader, otherField: "kept" } as any;
      const cfg = withSiteGlobals(input);
      expect(cfg).toBe(input);
      expect(cfg.loader).toBe(baseLoader);
    });
  });

  describe("dedupeGlobals", () => {
    it("returns empty when globals is empty", () => {
      expect(
        dedupeGlobals(
          [],
          [{ component: "Header.tsx", props: {}, key: "p0" }],
        ),
      ).toEqual([]);
    });

    it("drops globals whose component already appears in existing", () => {
      const globals = [
        { component: "Theme.tsx", props: {}, key: "g0" },
        { component: "Session.tsx", props: {}, key: "g1" },
      ];
      const existing = [
        { component: "Session.tsx", props: { fromPage: true }, key: "p0" },
      ];

      const result = dedupeGlobals(globals, existing);
      // Session dropped (already on page); Theme kept.
      expect(result.map((s) => s.component)).toEqual(["Theme.tsx"]);
    });

    it("dedupes within globals (first-wins)", () => {
      const globals = [
        { component: "Session.tsx", props: { from: "global" }, key: "g0" },
        { component: "Session.tsx", props: { from: "pageSections" }, key: "g1" },
      ];
      const result = dedupeGlobals(globals, []);
      expect(result).toHaveLength(1);
      expect(result[0].props.from).toBe("global");
    });
  });
});
