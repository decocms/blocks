import { registerCacheableSections, registerSectionLoader } from "@decocms/blocks/cms";
import type { ResolvedSection } from "@decocms/blocks/cms";
import { describe, expect, it } from "vitest";
import {
  CmsPagePendingFallback,
  cmsHomeRouteConfig,
  cmsRouteConfig,
  parseLoadCmsHomePageInput,
  parseLoadCmsPageInput,
  runSectionLoadersWithSeo,
} from "./cmsRoute";

describe("parseLoadCmsPageInput (#292)", () => {
  it("treats a bare string as the path with resolveGlobals defaulting to true (back-compat)", () => {
    expect(parseLoadCmsPageInput("/produto/tenis")).toEqual({
      path: "/produto/tenis",
      resolveGlobals: true,
    });
  });

  it("accepts { path, resolveGlobals } and preserves an explicit false", () => {
    expect(parseLoadCmsPageInput({ path: "/produto/tenis", resolveGlobals: false })).toEqual({
      path: "/produto/tenis",
      resolveGlobals: false,
    });
  });

  it("defaults resolveGlobals to true when omitted from the object form", () => {
    expect(parseLoadCmsPageInput({ path: "/produto/tenis" })).toEqual({
      path: "/produto/tenis",
      resolveGlobals: true,
    });
  });
});

describe("parseLoadCmsHomePageInput (#292)", () => {
  it("defaults resolveGlobals to true when called with no data (back-compat)", () => {
    expect(parseLoadCmsHomePageInput(undefined)).toEqual({ resolveGlobals: true });
  });

  it("preserves an explicit resolveGlobals: false", () => {
    expect(parseLoadCmsHomePageInput({ resolveGlobals: false })).toEqual({ resolveGlobals: false });
  });
});

/**
 * Regression guard for #355: body sections and the SEO section used to be
 * resolved sequentially (`runSectionLoaders` for the body, then a separate
 * `runSingleSectionLoader` call for the SEO section inside `buildPageSeo`).
 * On a PDP, both commonly resolve the SAME product via the SAME commerce
 * loader — sequential calls always missed the fetch-cache layer's in-flight
 * dedup (the body call had already completed by the time the SEO call
 * started). Batching them into one `runSectionLoaders` call (this file's
 * `runSectionLoadersWithSeo`) lets identical concurrent requests share one
 * origin round-trip.
 *
 * This test proves the batching by registering a *cacheable* section loader
 * (the same SWR + in-flight-dedup mechanism real commerce loaders use) and
 * asserting it's invoked only once when the body section and SEO section
 * share the same component + props.
 */
describe("runSectionLoadersWithSeo (#355)", () => {
  it("dedupes a same-component/same-props SEO section against a body section via the cacheable-section in-flight cache", async () => {
    const component = `test/sections/DedupCheck-${Date.now()}.tsx`;
    let calls = 0;

    registerCacheableSections({ [component]: { maxAge: 60_000 } });
    registerSectionLoader(component, async (props) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { ...props, loaded: true };
    });

    const bodySection: ResolvedSection = { component, props: { sku: "123" }, key: component, index: 0 };
    const seoSection: ResolvedSection = { component, props: { sku: "123" }, key: `${component}-seo`, index: -1 };

    const request = new Request("https://store.com/produto/123");
    const { enrichedSections, enrichedSeoSection } = await runSectionLoadersWithSeo(
      [bodySection],
      seoSection,
      request,
    );

    expect(calls).toBe(1);
    expect((enrichedSections[0].props as any).loaded).toBe(true);
    expect((enrichedSeoSection?.props as any).loaded).toBe(true);
  });

  it("runs plain runSectionLoaders when there is no SEO section", async () => {
    const component = `test/sections/NoSeo-${Date.now()}.tsx`;
    registerSectionLoader(component, async (props) => ({ ...props, loaded: true }));

    const bodySection: ResolvedSection = { component, props: {}, key: component, index: 0 };
    const { enrichedSections, enrichedSeoSection } = await runSectionLoadersWithSeo(
      [bodySection],
      null,
      new Request("https://store.com/"),
    );

    expect((enrichedSections[0].props as any).loaded).toBe(true);
    expect(enrichedSeoSection).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pending UI defaults
// ---------------------------------------------------------------------------
//
// There is deliberately NO default pendingComponent. Setting one turns every
// navigation slower than `pendingMs` (200ms) into a page → skeleton → page swap
// held for at least `pendingMinMs` (300ms). Deferral pulls most navigations into
// the 200–600ms band, i.e. exactly the window where that swap costs more than it
// buys, and this is a catch-all route, so one skeleton shape would have to serve
// PDP, PLP, search, and institutional pages alike. Keeping the previous page on
// screen until the new one commits is the better default; a site that wants a
// skeleton opts in per-shape.
//
// `pendingMs`/`pendingMinMs` DO keep defaults — they are inert without a
// pendingComponent, and they also govern a site-provided one.

describe("cmsRouteConfig / cmsHomeRouteConfig — pending UI defaults", () => {
  const base = { siteName: "Loja", defaultTitle: "Loja" };

  it("ships NO default pendingComponent — the previous page stays until commit", () => {
    expect("pendingComponent" in cmsRouteConfig(base)).toBe(false);
    expect("pendingComponent" in cmsHomeRouteConfig({ defaultTitle: "Loja" })).toBe(false);
  });

  it("honors a site-provided pendingComponent on both route configs", () => {
    const custom = () => null;
    expect(cmsRouteConfig({ ...base, pendingComponent: custom }).pendingComponent).toBe(custom);
    expect(
      cmsHomeRouteConfig({ defaultTitle: "Loja", pendingComponent: custom }).pendingComponent,
    ).toBe(custom);
  });

  it("treats an explicit null the same as omitting it", () => {
    expect("pendingComponent" in cmsRouteConfig({ ...base, pendingComponent: null })).toBe(false);
    expect(
      "pendingComponent" in cmsHomeRouteConfig({ defaultTitle: "Loja", pendingComponent: null }),
    ).toBe(false);
  });

  it("still exports CmsPagePendingFallback as an opt-in starting point", () => {
    expect(typeof CmsPagePendingFallback).toBe("function");
    expect(
      cmsRouteConfig({ ...base, pendingComponent: CmsPagePendingFallback }).pendingComponent,
    ).toBe(CmsPagePendingFallback);
  });

  it("keeps the documented pendingMs / pendingMinMs defaults", () => {
    const cfg = cmsRouteConfig(base);
    expect(cfg.pendingMs).toBe(200);
    expect(cfg.pendingMinMs).toBe(300);
  });
});
