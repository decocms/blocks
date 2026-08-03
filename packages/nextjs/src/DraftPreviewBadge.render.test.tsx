import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DraftPreviewBadge } from "./DraftPreviewBadge";

describe("DraftPreviewBadge (render)", () => {
  it("surfaces the preview-mode label so a reviewer can't mistake a draft for live", () => {
    const html = renderToString(<DraftPreviewBadge pointer="fila.vtex.app@v1" />);
    expect(html).toContain("Preview mode");
  });

  it("embeds the deco mark inline (no external asset that could 404 on a consumer site)", () => {
    const html = renderToString(<DraftPreviewBadge pointer="fila.vtex.app@v1" />);
    expect(html).toContain("data:image/png;base64,");
  });
});
