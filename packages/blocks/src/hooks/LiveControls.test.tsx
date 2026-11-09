import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LiveControls } from "./LiveControls";

// The bootstrap script guards on a window global, so it runs once for the file.
beforeAll(() => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<LiveControls site="shop" />);
  document.body.appendChild(host);
  const script = host.querySelector('script[type="module"]');
  new Function(script?.textContent ?? "")();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

describe('LiveControls "." shortcut', () => {
  it("Ctrl+. outside a field opens the editor chooser in a new tab", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    expect(press(document.body, { key: ".", ctrlKey: true }).defaultPrevented).toBe(true);
    const url = new URL(open.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://studio.decocms.com/choose-editor");
    expect(url.searchParams.get("site")).toBe("shop");
  });

  it("leaves typing in a field alone", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(press(input, { key: "." }).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    input.remove();
  });

  it("leaves typing in a field inside a shadow root alone (a third-party widget's form)", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).appendChild(input);
    // The document sees the host as the target; the email's "." must still type.
    expect(press(input, { key: "." }).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    host.remove();
  });
});
