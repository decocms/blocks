// @vitest-environment node
import { registerLayoutSections, registerSection, setBlocks } from "@decocms/blocks/cms";
import { isNotFound } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Server functions run their handler in-process; the request is a plain GET.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      inputValidator: () => builder,
      handler: (fn: (ctx: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        fn({ data: opts?.data }),
    };
    return builder;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestUrl: () => new URL("https://shop.example/nope"),
  getRequest: () => new Request("https://shop.example/nope"),
  getRequestHeader: () => "",
  getCookies: () => ({}),
  setCookie: () => {},
  setResponseHeader: () => {},
}));

const { cmsRouteConfig } = await import("./cmsRoute");
const { CmsNotFoundPage } = await import("./components");

const Header = "site/sections/Header/Header.tsx";
const Footer = "site/sections/Footer/Footer.tsx";
const Hero = "site/sections/Hero/Hero.tsx";
const Message = "site/sections/NotFound/NotFound.tsx";
for (const key of [Header, Footer, Hero, Message]) {
  registerSection(key, async () => ({ default: () => null }));
}
registerLayoutSections([Header, Footer]);

const home = {
  __resolveType: "website/pages/Page.tsx",
  path: "/",
  sections: [
    { __resolveType: "Header - 01" },
    { __resolveType: Hero, title: "never resolved on a 404" },
    { __resolveType: "website/sections/Rendering/Lazy.tsx", section: { __resolveType: Footer } },
  ],
};
const headerBlock = { __resolveType: Header, logo: "acme" };

async function missWith(notFoundPath?: string | false) {
  const config = cmsRouteConfig({ siteName: "Acme", defaultTitle: "Acme", notFoundPath });
  try {
    return { returned: await config.loader({ params: { _splat: "nope" }, deps: {} }) };
  } catch (err) {
    return { thrown: err as { data?: any } };
  }
}

describe("cmsRouteConfig — unknown URLs answer 404 with the site's chrome", () => {
  it("throws notFound() carrying the CMS /404 page when the site has one", async () => {
    setBlocks({
      "pages-home": home,
      "Header - 01": headerBlock,
      "pages-404": {
        __resolveType: "website/pages/Page.tsx",
        path: "/404",
        sections: [{ __resolveType: "Header - 01" }, { __resolveType: Message }],
      },
    });
    const { thrown } = await missWith();
    expect(isNotFound(thrown)).toBe(true);
    expect(thrown?.data.messageAt).toBeUndefined();
    expect(thrown?.data.resolvedSections.map((s: any) => s.component)).toEqual([Header, Message]);
  });

  it("without a /404 page, wraps the default message in the homepage's Header and Footer only", async () => {
    setBlocks({ "pages-home": home, "Header - 01": headerBlock });
    const { thrown } = await missWith();
    expect(isNotFound(thrown)).toBe(true);
    const data = thrown?.data;
    expect(data.resolvedSections.map((s: any) => s.component)).toEqual([Header, Footer]);
    expect(data.messageAt).toBe(1);

    const html = renderToString(<CmsNotFoundPage data={data} />);
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("No CMS page block"); // dev-only hint
  });

  it("notFoundPath: false keeps the old contract (loader resolves null)", async () => {
    setBlocks({ "pages-home": home });
    expect(await missWith(false)).toEqual({ returned: null });
  });

  it("serves the 404 uncached, noindex, with CmsNotFoundPage by default", () => {
    const config = cmsRouteConfig({ siteName: "Acme", defaultTitle: "Acme" });
    expect(config.notFoundComponent).toBe(CmsNotFoundPage);
    expect(config.headers({ loaderData: undefined })["Cache-Control"]).not.toMatch(
      /s-maxage=[1-9]/,
    );
    const robots = config.head({ loaderData: undefined }).meta.find((m) => m.name === "robots");
    expect(robots?.content).toBe("noindex, nofollow");
  });
});
