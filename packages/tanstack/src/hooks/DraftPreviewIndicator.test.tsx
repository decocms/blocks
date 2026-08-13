import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DRAFT_POINTER_BAG_KEY, DRAFT_POINTER_GLOBAL } from "../sdk/draftShared";
import { DraftPreviewIndicator } from "./DraftPreviewIndicator";

const POINTER = "abc.preview-studio.decocms.com@v1";

function renderInRequest(pointer: string | null): string {
  return RequestContext.run(new Request("https://example.com/"), () => {
    if (pointer) RequestContext.setBag(DRAFT_POINTER_BAG_KEY, pointer);
    return renderToString(<DraftPreviewIndicator />);
  });
}

describe("DraftPreviewIndicator — SSR", () => {
  it("publishes the pointer on a global so client hydration matches", () => {
    const html = renderInRequest(POINTER);
    expect(html).toContain(`window.${DRAFT_POINTER_GLOBAL}=`);
    expect(html).toContain(JSON.stringify(POINTER));
    // The chip itself fails closed — nothing visible until the client effect.
    expect(html).not.toContain("Preview mode");
  });

  it("renders nothing when the request is not drafting", () => {
    expect(renderInRequest(null)).toBe("");
  });
});

describe("DraftPreviewIndicator — client", () => {
  let container: HTMLDivElement;
  let root: Root;
  const win = window as unknown as Record<string, string | undefined>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    win[DRAFT_POINTER_GLOBAL] = undefined;
  });

  it("mounts the badge from the published global (cookie-nav, no bag on the client)", () => {
    win[DRAFT_POINTER_GLOBAL] = POINTER;
    act(() => root.render(<DraftPreviewIndicator />));
    expect(container.textContent).toContain("Preview mode");
  });

  it("renders nothing when no pointer is published", () => {
    act(() => root.render(<DraftPreviewIndicator />));
    expect(container.textContent).toBe("");
  });
});
