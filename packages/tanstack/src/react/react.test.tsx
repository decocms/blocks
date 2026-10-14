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
import { DecoDocument } from "./DecoDocument.tsx";
import { pageValues, publishScript } from "./pageValues.ts";

async function render(scope: { csegToken?: string; draft?: string }, props = {}) {
  const rootRoute = createRootRoute({
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
  it("renders the document with Studio's bridge, the events bus and data-theme=light", async () => {
    const html = await render({});
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toContain('class="bg-base-200 text-base-content"');
    expect(html).toContain('data-site="acme"');
    expect(html).toContain("editor::inject");
    expect(html).toContain("window.DECO.events");
    expect(html).toContain('id="extra"');
    expect(html).toMatch(/<main><div>/);
    expect(html).not.toContain("__DECO_CSEG");
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
        editShortcut: true,
      },
    );
    expect(html).toContain('<html lang="pt-BR"');
    expect(html).toContain('class="bg-white"');
    expect(html).toContain('account: "acme-vtex"');
    expect(html).not.toMatch(/<main><div>/);
    expect(html).toContain("data-shortcut");
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
