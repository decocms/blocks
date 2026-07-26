import { registerCacheableSections, registerSectionLoader } from "@decocms/blocks/cms";
import type { ResolvedSection } from "@decocms/blocks/cms";
import { describe, expect, it } from "vitest";
import { runSectionLoadersWithSeo } from "./cmsRoute";

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
