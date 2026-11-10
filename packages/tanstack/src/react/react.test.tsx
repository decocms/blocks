// @vitest-environment node
/**
 * DecoDocument on the server: the document's fixed parts, and the page values
 * (the CDN segment token and the draft) the worker handed the render.
 */
import { runInScope } from "@decocms/tanstack/scope";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecoDocument, DecoPreview } from "./DecoDocument.tsx";
import { pageValues, publishScript } from "./pageValues.ts";

async function render(
  scope: { csegToken?: string; draft?: string },
  props = {},
  loader?: () => unknown,
) {
  const rootRoute = createRootRoute({
    loader,
    component: () => (
      <DecoDocument site="acme" {...props}>
        <p id="extra">extra</p>
      </DecoDocument>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return runInScope(scope, async () => {
    await router.load();
    return renderToString(<RouterProvider router={router} />);
  });
}

describe("DecoDocument", () => {
  it('renders the document with the "." shortcut, the events bus and data-theme=light', async () => {
    const html = await render({});
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toContain('class="bg-base-200 text-base-content"');
    expect(html).toContain('data-site="acme"');
    expect(html).not.toContain("scrollToComponent");
    expect(html).not.toContain("editor::rerender");
    expect(html).not.toContain("editor::inject");
    expect(html).toContain("window.DECO.events");
    expect(html).toContain('id="extra"');
    expect(html).toMatch(/<main><div>/);
    expect(html).not.toContain("__DECO_CSEG");
  });

  it("mounts the Studio channel: Studio's production and staging origins, the option, or DECO_STUDIO_ORIGIN", async () => {
    const channel = (html: string) =>
      html.match(/<script[^>]*data-deco-studio-channel[^>]*>/)?.[0] ?? "";
    const env = process.env.DECO_STUDIO_ORIGIN;
    delete process.env.DECO_STUDIO_ORIGIN;
    try {
      expect(channel(await render({}, { nonce: "n1" }))).toBe(
        '<script data-deco-studio-channel="" data-studio-origins="[&quot;https://studio.decocms.com&quot;,&quot;https://studio-stg.decocms.com&quot;]" nonce="n1">',
      );
      process.env.DECO_STUDIO_ORIGIN = "http://localhost:3000,https://studio.example.com";
      expect(channel(await render({}))).toContain(
        'data-studio-origins="[&quot;http://localhost:3000&quot;,&quot;https://studio.example.com&quot;]"',
      );
      expect(
        channel(await render({}, { studioOrigins: ["https://studio-stg.decocms.com"] })),
      ).toContain('data-studio-origins="[&quot;https://studio-stg.decocms.com&quot;]"');
    } finally {
      if (env === undefined) delete process.env.DECO_STUDIO_ORIGIN;
      else process.env.DECO_STUDIO_ORIGIN = env;
    }
  });

  it('is v8 only: the "." shortcut answers no message, so it carries no origin list', async () => {
    const html = await render({});
    const tag = html.match(/<script[^>]*data-deco-studio-bridge[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('data-site="acme"');
    expect(html).not.toContain("data-origins=");
  });

  it("its Studio scripts are the \".\" shortcut's and the channel's, nothing else (tests/studio-shortcut.test.ts)", async () => {
    const { StudioChannel } = await import("@decocms/blocks/preview");
    const { StudioShortcut } = await import("../studioShortcut.ts");
    const env = process.env.DECO_STUDIO_ORIGIN;
    delete process.env.DECO_STUDIO_ORIGIN;
    try {
      const html = await render({}, { nonce: "n1" }, () => ({ pathTemplate: "/:slug/p" }));
      const tags = html.match(/<script[^>]*data-deco-studio-[^>]*>[\s\S]*?<\/script>/g) ?? [];
      expect(tags).toEqual([
        renderToString(
          <StudioShortcut site="acme" nonce="n1" page={{ pathTemplate: "/:slug/p" }} />,
        ),
        renderToString(
          <StudioChannel
            studioOrigins={["https://studio.decocms.com", "https://studio-stg.decocms.com"]}
            nonce="n1"
          />,
        ),
      ]);
      expect(html).not.toMatch(/window\.(self|top)\s*[!=]==?\s*window\.(self|top)/);
    } finally {
      if (env !== undefined) process.env.DECO_STUDIO_ORIGIN = env;
    }
  });

  it("publishes the request's CDN segment token and draft", async () => {
    const html = await render({ csegToken: "a1b2c3d4", draft: "studio.decocms.com/x@1" });
    expect(html).toContain(
      'window.__DECO_CSEG="a1b2c3d4";window.__DECO_DRAFT="studio.decocms.com/x@1"',
    );
  });

  it("takes the site's language, body class, account and outlet element", async () => {
    const html = await render(
      {},
      {
        lang: "pt-BR",
        bodyClassName: "bg-white",
        account: "acme-vtex",
        outlet: "div",
      },
    );
    expect(html).toContain('<html lang="pt-BR"');
    expect(html).toContain('class="bg-white"');
    expect(html).toContain('account: "acme-vtex"');
    expect(html).not.toMatch(/<main><div>/);
    expect(html).toContain("data-shortcut");
  });

  it("turns the edit shortcut off only when told to", async () => {
    // The shortcut's own script mentions the attribute, so look at its tag only.
    const bridgeTag = (html: string) =>
      html.match(/<script[^>]*data-deco-studio-bridge[^>]*>/)?.[0] ?? "";
    expect(bridgeTag(await render({}))).toContain("data-shortcut");
    expect(bridgeTag(await render({}, { editShortcut: false }))).not.toContain("data-shortcut");
  });
});

describe("the page the edit shortcut opens", () => {
  const bridgeTag = (html: string) =>
    html.match(/<script[^>]*data-deco-studio-bridge[^>]*>/)?.[0] ?? "";

  it("is the route's pathTemplate and pageId, on the bridge", async () => {
    const tag = bridgeTag(
      await render({}, {}, () => ({ pathTemplate: "/:slug/p", pageId: "pages-pdp", name: "PDP" })),
    );
    expect(tag).toContain('data-path-template="/:slug/p"');
    expect(tag).toContain('data-page-id="pages-pdp"');
  });

  it("is absent when no route says (Studio falls back to the URL)", async () => {
    const tag = bridgeTag(await render({}, {}, () => ({ name: "x" })));
    expect(tag).not.toContain("data-path-template");
    expect(tag).not.toContain("data-page-id");
  });
});

describe("DecoPreview, for a site's own document", () => {
  async function renderOwn(scope: { csegToken?: string; draft?: string }) {
    const rootRoute = createRootRoute({
      loader: () => ({ pathTemplate: "/:slug" }),
      component: () => (
        <html lang="pt-BR">
          <body>
            <a href="#main-content">skip</a>
            <main id="main-content" />
            <DecoPreview site="blog" />
          </body>
        </html>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    return runInScope(scope, async () => {
      await router.load();
      return renderToString(<RouterProvider router={router} />);
    });
  }

  it("publishes the draft and mounts the bridge with the page, after the site's own markup", async () => {
    const html = await renderOwn({ draft: "studio.decocms.com/x@1" });
    expect(html).toContain('window.__DECO_DRAFT="studio.decocms.com/x@1"');
    const tag = html.match(/<script[^>]*data-deco-studio-bridge[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('data-site="blog"');
    expect(tag).toContain('data-path-template="/:slug"');
    expect(html.indexOf('href="#main-content"')).toBeLessThan(
      html.indexOf("data-deco-studio-bridge"),
    );
  });

  it("publishes nothing without a draft or segment", async () => {
    expect(await renderOwn({})).not.toContain("__DECO_DRAFT");
  });
});

describe("page values", () => {
  it("come from the request scope on the server", () => {
    runInScope({ csegToken: "t", draft: "d" }, () => {
      expect(pageValues()).toEqual({ cseg: "t", draft: "d" });
    });
    expect(pageValues()).toEqual({ cseg: undefined, draft: undefined });
  });

  it("publish as inert JS, nothing when empty", () => {
    expect(publishScript({})).toBeNull();
    expect(publishScript({ draft: "</script><script>alert(1)</script>" })).toBe(
      'window.__DECO_DRAFT="\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"',
    );
  });
});
