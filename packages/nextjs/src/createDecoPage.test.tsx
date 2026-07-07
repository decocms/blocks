import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { registerSections, setBlocks } from "@decocms/blocks/cms";
import { createDecoPage } from "./createDecoPage";

function Hero({ label }: { label?: string }) {
  return <h1>{`hero-${label ?? "none"}`}</h1>;
}

describe("createDecoPage (next)", () => {
  it("resolves and renders the page for the current path", async () => {
    // registerSections (the async-loader registry, packages/blocks/src/cms/registry.ts)
    // — NOT registerSectionsSync — is what resolveDecoPage's pipeline reads:
    // resolveRawSection() gates each raw CMS section through getSection(),
    // which only consults the registry registerSections populates.
    // registerSectionsSync populates a separate `syncComponents` map that
    // SectionRenderer checks first for already-rendered pages, but a section
    // registered ONLY via registerSectionsSync is silently dropped (with a
    // "[CMS] No component registered for: ..." warning) during CMS
    // resolution itself — confirmed by running this test against the plan's
    // original registerSectionsSync-based sketch.
    registerSections({ "site/sections/CreateDecoPageHero.tsx": async () => ({ default: Hero }) });
    // Block key MUST start with "pages-" — that's the prefix getAllPages()
    // (packages/blocks/src/cms/loader.ts) filters on. The plan's sketch used
    // "pages/home.json", which getAllPages() would silently skip, so
    // resolveDecoPage would return null and this test would fail even with a
    // correct implementation.
    setBlocks({
      "pages-home": {
        path: "/",
        sections: [{ __resolveType: "site/sections/CreateDecoPageHero.tsx", label: "home" }],
        seo: {
          __resolveType: "website/sections/Seo/SeoV2.tsx",
          title: "Home title",
          description: "Home description",
        },
      },
    });

    const { generateMetadata, default: Page } = createDecoPage({ siteName: "test-site" });

    const element = await Page({ params: Promise.resolve({ slug: [] }) });
    const html = renderToString(element);
    expect(html).toContain("hero-home");

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: [] }) });
    expect(metadata.title).toBe("Home title");
    expect(metadata.description).toBe("Home description");
  });

  it("calls next/navigation notFound() when no page matches the path", async () => {
    setBlocks({
      "pages-home": {
        path: "/",
        sections: [{ __resolveType: "site/sections/CreateDecoPageHero.tsx", label: "home" }],
      },
    });

    const { default: Page } = createDecoPage({ siteName: "test-site" });

    await expect(
      Page({ params: Promise.resolve({ slug: ["missing"] }) }),
    ).rejects.toThrow();
  });
});
