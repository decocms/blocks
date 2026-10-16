// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const slot = vi.hoisted(() => ({ pointer: null as string | null }));
vi.mock("./server/slot.ts", () => ({ activeDraftPointer: () => slot.pointer }));

const { DraftPreviewIndicator, StudioBridge, StudioPage } = await import("./index.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POINTER = "studio.decocms.com/api/acme/decofile/mcp/main?token=t@v1";

afterEach(() => {
  slot.pointer = null;
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
});

describe("StudioBridge", () => {
  it("is @decocms/blocks/preview's script, answering Studio's origins (STUDIO_ORIGINS)", async () => {
    const preview = await import("@decocms/blocks/preview");
    const { STUDIO_ORIGINS } = await import("./studio.ts");
    const html = renderToStaticMarkup(<StudioBridge site="acme" />);
    expect(html).toMatch(/^<script[^>]*>/);
    expect(html).toBe(
      renderToStaticMarkup(<preview.StudioBridge site="acme" trustedOrigins={STUDIO_ORIGINS} />),
    );
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = html;
    const script = host.querySelector("script[data-deco-studio-bridge]");
    expect(script?.getAttribute("data-site")).toBe("acme");
    expect(JSON.parse(script?.getAttribute("data-origins") ?? "null")).toEqual([
      "https://studio.decocms.com",
      "https://studio-stg.decocms.com",
      "https://decocms.com",
      "https://*.decocms.com",
    ]);
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
