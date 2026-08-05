import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DraftPreviewBadge } from "./DraftPreviewBadge";

describe("DraftPreviewBadge (render)", () => {
  // Raw SSR (react-dom/server) never runs effects — this is what a consumer
  // site that never hydrates this component, or the server's own render
  // pass, actually ships. The badge fails closed: nothing here, by design
  // (see the module doc for why render-then-hide is worse).
  it("renders nothing without a client to run the reveal effect", () => {
    const html = renderToString(<DraftPreviewBadge pointer="fila.vtex.app@v1" />);
    expect(html).toBe("");
  });

  describe("mounted in a browser", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });

    it("reveals the preview-mode label after mount, once confirmed unframed", () => {
      act(() => {
        root.render(<DraftPreviewBadge pointer="fila.vtex.app@v1" />);
      });
      expect(container.textContent).toContain("Preview mode");
    });

    it("embeds the deco mark inline (no external asset that could 404 on a consumer site)", () => {
      act(() => {
        root.render(<DraftPreviewBadge pointer="fila.vtex.app@v1" />);
      });
      expect(container.innerHTML).toContain("data:image/png;base64,");
    });

    describe("embedded in an iframe", () => {
      const realTop = window.top;
      afterEach(() => {
        Object.defineProperty(window, "top", {
          value: realTop,
          configurable: true,
        });
      });

      it("stays hidden — Studio's own preview surface already has its own chrome", () => {
        Object.defineProperty(window, "top", { value: {}, configurable: true });
        act(() => {
          root.render(<DraftPreviewBadge pointer="fila.vtex.app@v1" />);
        });
        expect(container.textContent).toBe("");
      });
    });
  });
});
