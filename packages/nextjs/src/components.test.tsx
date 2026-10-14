// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const slot = vi.hoisted(() => ({ pointer: null as string | null }));
vi.mock("./server/slot.ts", () => ({ activeDraftPointer: () => slot.pointer }));

const { DraftPreviewIndicator, StudioBridge } = await import("./index.ts");

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
  it("is @decocms/blocks/preview's, rendered on the server as one script", async () => {
    const preview = await import("@decocms/blocks/preview");
    expect(StudioBridge).toBe(preview.StudioBridge);
    expect(renderToStaticMarkup(<StudioBridge site="acme" />)).toMatch(/^<script[^>]*>/);
  });
});
