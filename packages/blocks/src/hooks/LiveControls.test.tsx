import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveControls } from "./LiveControls";

describe("LiveControls", () => {
  it("always ships the keyboard shortcut", () => {
    for (const editorBridge of [true, false]) {
      const html = renderToString(<LiveControls site="s" editorBridge={editorBridge} />);
      expect(html).toContain("choose-editor");
      expect(html).toContain("keydown");
    }
  });

  it("ships the admin message bridge (editor::inject eval) only when editorBridge", () => {
    expect(renderToString(<LiveControls site="s" editorBridge />)).toContain("editor::inject");
    expect(renderToString(<LiveControls site="s" />)).toContain("editor::inject");
    const published = renderToString(<LiveControls site="s" editorBridge={false} />);
    expect(published).not.toContain("editor::inject");
    expect(published).not.toContain("eval(");
    expect(published).not.toContain('"message"');
  });
});
