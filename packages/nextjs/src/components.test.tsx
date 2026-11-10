// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const slot = vi.hoisted(() => ({ pointer: null as string | null, unavailable: false }));
vi.mock("./server/slot.ts", () => ({
  activeDraftPointer: () => slot.pointer,
  draftUnavailable: () => slot.unavailable,
}));
// StudioBridge renders StudioRefresh, which needs the App Router mounted.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {} }) }));

const { DraftPreviewIndicator, StudioBridge, StudioPage } = await import("./index.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POINTER = "studio.decocms.com/api/acme/decofile/mcp/main?token=t@v1";

afterEach(() => {
  slot.pointer = null;
  slot.unavailable = false;
  document.body.innerHTML = "";
});

describe("DraftPreviewIndicator", () => {
  it("renders nothing when no draft is bound", () => {
    expect(renderToStaticMarkup(<DraftPreviewIndicator />)).toBe("");
  });

  it("mounts the badge for the bound draft", async () => {
    slot.pointer = POINTER;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<DraftPreviewIndicator exitHref="/?__draft=off" />));
    expect(host.querySelector("[data-deco-preview-badge]")).not.toBe(null);
    expect(host.textContent).toContain("Preview mode");
    await act(async () => root.unmount());
  });

  it("a link to a draft that's gone: the calm notice, no badge", async () => {
    slot.unavailable = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<DraftPreviewIndicator />));
    expect(host.querySelector("[data-deco-preview-badge]")).toBe(null);
    expect(host.textContent).toContain("This draft isn't available anymore.");
    await act(async () => root.unmount());
  });
});

describe("StudioBridge", () => {
  it('is the "." shortcut and the Studio channel: v8 only, nothing of v7\'s framed handler', async () => {
    const preview = await import("@decocms/blocks/preview");
    const { StudioShortcut } = await import("./studioShortcut.ts");
    const html = renderToStaticMarkup(<StudioBridge site="acme" />);
    expect(html).toMatch(/^<script[^>]*>/);
    expect(html).toBe(
      renderToStaticMarkup(<StudioShortcut site="acme" />) +
        renderToStaticMarkup(
          <preview.StudioChannel
            studioOrigins={["https://studio.decocms.com", "https://studio-stg.decocms.com"]}
          />,
        ),
    );
    expect(html).not.toContain("scrollToComponent");
    expect(html).not.toContain("editor::rerender");
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = html;
    const script = host.querySelector("script[data-deco-studio-bridge]");
    expect(script?.getAttribute("data-site")).toBe("acme");
    expect(script?.hasAttribute("data-origins")).toBe(false);
  });

  it("mounts the Studio channel for Studio's production and staging origins, the option, or DECO_STUDIO_ORIGIN", () => {
    const origins = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      const script = host.querySelector("script[data-deco-studio-channel]");
      return [
        JSON.parse(script?.getAttribute("data-studio-origins") ?? "null"),
        script?.getAttribute("nonce"),
      ];
    };
    const env = process.env.DECO_STUDIO_ORIGIN;
    delete process.env.DECO_STUDIO_ORIGIN;
    try {
      expect(origins(renderToStaticMarkup(<StudioBridge site="acme" nonce="n1" />))).toEqual([
        ["https://studio.decocms.com", "https://studio-stg.decocms.com"],
        "n1",
      ]);
      process.env.DECO_STUDIO_ORIGIN = "http://localhost:3000, https://studio.example.com";
      expect(origins(renderToStaticMarkup(<StudioBridge site="acme" />))[0]).toEqual([
        "http://localhost:3000",
        "https://studio.example.com",
      ]);
      expect(
        origins(
          renderToStaticMarkup(
            <StudioBridge site="acme" studioOrigins={["https://studio-stg.decocms.com"]} />,
          ),
        )[0],
      ).toEqual(["https://studio-stg.decocms.com"]);
    } finally {
      if (env === undefined) delete process.env.DECO_STUDIO_ORIGIN;
      else process.env.DECO_STUDIO_ORIGIN = env;
    }
  });

  it("passes the site's shortcut and nonce through", () => {
    const html = renderToStaticMarkup(<StudioBridge site="acme" editShortcut nonce="n1" />);
    expect(html).toContain('data-shortcut=""');
    expect(html).toContain('nonce="n1"');
  });

  it("passes the page through, and StudioPage is the marker a page renders", () => {
    const html = renderToStaticMarkup(
      <StudioBridge site="acme" page={{ pathTemplate: "/:slug/p", id: "pages-pdp" }} />,
    );
    expect(html).toContain('data-path-template="/:slug/p"');
    expect(html).toContain('data-page-id="pages-pdp"');
    expect(renderToStaticMarkup(<StudioPage pathTemplate="/s" />)).toBe(
      '<meta name="deco:page" content="/s" data-deco-page="" data-path-template="/s"/>',
    );
  });
});
