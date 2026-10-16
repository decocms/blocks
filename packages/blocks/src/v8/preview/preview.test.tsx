// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExitUrl, buildShareUrl, DraftBadge, isFramed } from "./DraftBadge.tsx";
import { StudioBridge, type StudioBridgeProps, StudioPage } from "./StudioBridge.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POINTER = "shop.example.com/products/shoe@v1";

/** What a binding passes as `trustedOrigins`: Studio's origins (blocks holds no list of its own). */
const STUDIO = [
  "https://studio.decocms.com",
  "https://studio-stg.decocms.com",
  "https://decocms.com",
  "https://*.decocms.com",
];

describe("DraftBadge links", () => {
  it("share pins the exact draft version and keeps the other parameters", () => {
    expect(buildShareUrl("https://shop.example.com/plp?sort=price", POINTER)).toBe(
      "https://shop.example.com/plp?sort=price&__draft=shop.example.com%2Fproducts%2Fshoe%40v1",
    );
  });

  it("share replaces a draft already in the URL", () => {
    expect(buildShareUrl("https://shop.example.com/p?__draft=old%40v0", "h/@v2")).toBe(
      "https://shop.example.com/p?__draft=h%2F%40v2",
    );
  });

  it("exit sets ?__draft=off", () => {
    expect(buildExitUrl("https://shop.example.com/p?__draft=x%40v1&a=1")).toBe(
      "https://shop.example.com/p?__draft=off&a=1",
    );
  });

  it("isFramed compares the window with its top", () => {
    expect(isFramed(undefined)).toBe(false);
    const w = {} as Window & typeof globalThis;
    (w as { top: unknown }).top = w;
    expect(isFramed(w)).toBe(false);
    (w as { top: unknown }).top = {};
    expect(isFramed(w)).toBe(true);
  });
});

describe("DraftBadge", () => {
  it("renders nothing on the server (it shows only after an effect confirms it isn't framed)", () => {
    expect(renderToString(<DraftBadge pointer={POINTER} />)).toBe("");
  });

  describe("in a browser", () => {
    let container: HTMLDivElement;
    let root: Root;
    const realTop = window.top;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      Object.defineProperty(window, "top", { value: realTop, configurable: true });
      vi.restoreAllMocks();
    });

    it("shows the badge with the inlined mark on a draft page", () => {
      act(() => root.render(<DraftBadge pointer={POINTER} />));
      expect(container.textContent).toBe("Preview mode");
      expect(container.querySelector("img")?.getAttribute("src")).toMatch(
        /^data:image\/png;base64,/,
      );
    });

    it("the inlined mark stays small: it ships in every client bundle that mounts the badge", () => {
      act(() => root.render(<DraftBadge pointer={POINTER} />));
      expect(container.querySelector("img")?.getAttribute("src")?.length).toBeLessThan(4096);
    });

    it("renders nothing without a draft", () => {
      for (const pointer of [null, undefined, ""]) {
        act(() => root.render(<DraftBadge pointer={pointer} />));
        expect(container.innerHTML).toBe("");
      }
    });

    it("renders nothing inside a frame (Studio's site editor)", () => {
      Object.defineProperty(window, "top", { value: {}, configurable: true });
      act(() => root.render(<DraftBadge pointer={POINTER} />));
      expect(container.innerHTML).toBe("");
    });

    it("opens the menu, closes it on Escape, and copies the share link", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      act(() => root.render(<DraftBadge pointer={POINTER} />));
      const toggle = container.querySelector("button[aria-label='Preview mode']") as HTMLElement;

      act(() => toggle.click());
      const items = container.querySelectorAll("[role=menuitem]");
      expect([...items].map((b) => b.textContent)).toEqual(["Exit preview", "Share preview"]);

      await act(async () => (items[1] as HTMLElement).click());
      expect(writeText).toHaveBeenCalledWith(buildShareUrl(window.location.href, POINTER));
      expect(container.textContent).toContain("Copied!");

      act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(container.querySelector("[role=menu]")).toBeNull();
    });
  });
});

/**
 * Runs the bridge the way a browser does: the server-rendered script element
 * as `document.currentScript`, its text evaluated once.
 */
function mountBridge(props: StudioBridgeProps, framed: boolean): () => void {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<StudioBridge {...props} />);
  const script = host.querySelector("script") as HTMLScriptElement;
  document.body.appendChild(host);
  const realTop = window.top;
  const realParent = window.parent;
  // The parent window: a real window object, so it can be a MessageEvent's source.
  const parent = framed ? (document.createElement("iframe") as HTMLIFrameElement) : null;
  if (parent) document.body.appendChild(parent);
  if (framed) {
    Object.defineProperty(window, "top", { value: parent?.contentWindow, configurable: true });
    Object.defineProperty(window, "parent", { value: parent?.contentWindow, configurable: true });
  }
  const added: [string, EventListener][] = [];
  const winAdd = window.addEventListener.bind(window);
  const docAdd = document.addEventListener.bind(document);
  const spyWin = vi.spyOn(window, "addEventListener").mockImplementation((t, l, o) => {
    added.push([t, l as EventListener]);
    winAdd(t, l, o);
  });
  const spyDoc = vi.spyOn(document, "addEventListener").mockImplementation((t, l, o) => {
    added.push([t, l as EventListener]);
    docAdd(t, l, o);
  });
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  try {
    // A global-scope function, as a browser runs a classic script.
    new Function(script.textContent ?? "")();
  } finally {
    Object.defineProperty(document, "currentScript", { value: null, configurable: true });
    spyWin.mockRestore();
    spyDoc.mockRestore();
  }
  return () => {
    for (const [t, l] of added) {
      window.removeEventListener(t, l);
      document.removeEventListener(t, l);
    }
    Object.defineProperty(window, "top", { value: realTop, configurable: true });
    Object.defineProperty(window, "parent", { value: realParent, configurable: true });
    delete (window as { __decoStudioBridge?: boolean }).__decoStudioBridge;
    parent?.remove();
    host.remove();
  };
}

function post(data: unknown, origin: string, source: Window | null = window.parent): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

type Probe = { __probe?: string[] };
const probe = () => ((globalThis as Probe).__probe ??= []);
const injectProbe = (tag: string) => ({
  type: "editor::inject",
  args: { script: `globalThis.__probe.push(${JSON.stringify(tag)})` },
});

describe("StudioBridge", () => {
  let unmount: (() => void) | undefined;
  beforeEach(() => {
    (globalThis as Probe).__probe = [];
  });
  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.restoreAllMocks();
  });

  it("renders one static script; its settings are attributes, with exactly the origins it was given", () => {
    const html = renderToStaticMarkup(
      <StudioBridge site="shop" nonce="n0" trustedOrigins={[...STUDIO, "http://localhost:4000"]} />,
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    const script = host.querySelector("script") as HTMLScriptElement;
    expect(host.children).toHaveLength(1);
    expect(script.getAttribute("data-site")).toBe("shop");
    expect(script.getAttribute("nonce")).toBe("n0");
    expect(script.hasAttribute("data-shortcut")).toBe(true);
    expect(JSON.parse(script.getAttribute("data-origins") ?? "")).toEqual([
      ...STUDIO,
      "http://localhost:4000",
    ]);
    // Site values never reach the script body.
    const other = renderToStaticMarkup(
      <StudioBridge site="other" trustedOrigins={[...STUDIO, "http://localhost:4000"]} />,
    );
    expect(other.slice(other.indexOf(">"))).toBe(html.slice(html.indexOf(">")));
  });

  it("escapes a site name in the attribute", () => {
    const html = renderToStaticMarkup(
      <StudioBridge site={'"><script>x</script>'} trustedOrigins={STUDIO} />,
    );
    expect(html).not.toContain("<script>x");
  });

  it("runs Studio's editor::inject in a frame, the way Studio v8 sends it", () => {
    unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, true);
    post(injectProbe("studio"), "https://studio.decocms.com");
    expect(probe()).toEqual(["studio"]);
  });

  it("answers exactly the origins Studio's list matches: https, default port, decocms.com or a name under it", () => {
    unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, true);
    const origins = [
      "https://studio.decocms.com",
      "https://studio-stg.decocms.com",
      "https://decocms.com",
      "https://a.b.decocms.com",
      "http://studio.decocms.com",
      "https://studio.decocms.com:8443",
      "https://decocms.com.evil.example",
      "https://evildecocms.com",
      "https://admin.deco.cx",
      "https://deco.cx",
      window.location.origin,
      "null",
      "",
    ];
    for (const origin of origins) post(injectProbe(origin), origin);
    expect(probe()).toEqual([
      "https://studio.decocms.com",
      "https://studio-stg.decocms.com",
      "https://decocms.com",
      "https://a.b.decocms.com",
    ]);
  });

  it("trusts no origin of its own: with an empty list it answers nothing, not even Studio", () => {
    unmount = mountBridge({ site: "shop", trustedOrigins: [] }, true);
    post(injectProbe("studio"), "https://studio.decocms.com");
    post(injectProbe("self"), window.location.origin);
    expect(probe()).toEqual([]);
  });

  it("answers any origin it is given, exact and wildcard", () => {
    unmount = mountBridge(
      { site: "shop", trustedOrigins: ["http://localhost:4000", "https://*.studio.test"] },
      true,
    );
    for (const origin of [
      "http://localhost:4000",
      "http://localhost:4001",
      "https://a.studio.test",
      "https://studio.test",
    ]) {
      post(injectProbe(origin), origin);
    }
    expect(probe()).toEqual(["http://localhost:4000", "https://a.studio.test"]);
  });

  it("ignores a Studio-origin message that doesn't come from the parent window", () => {
    unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, true);
    post(injectProbe("self"), "https://studio.decocms.com", window);
    expect(probe()).toEqual([]);
  });

  it("does nothing when the page isn't framed", () => {
    unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, false);
    post(injectProbe("top"), "https://studio.decocms.com", null);
    expect(probe()).toEqual([]);
  });

  it("ignores malformed messages and reports a failing script without throwing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, true);
    for (const data of [null, "editor::inject", { type: "editor::inject" }, { type: "other" }]) {
      post(data, "https://studio.decocms.com");
    }
    post(
      { type: "editor::inject", args: { script: "throw new Error('x')" } },
      "https://studio.decocms.com",
    );
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("scrolls to a section on scrollToComponent", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const section = document.createElement("section");
    section.setAttribute("data-manifest-key", 'site/sections/Hero.tsx"x');
    document.body.appendChild(section);
    unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, true);
    post(
      { type: "scrollToComponent", args: { id: 'site/sections/Hero.tsx"x' } },
      "https://decocms.com",
    );
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(section);
    section.remove();
  });

  it("runs once when rendered twice", () => {
    unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, true);
    const second = mountBridge({ site: "shop", trustedOrigins: STUDIO }, true);
    // The second copy saw the global flag and returned before adding a listener.
    post(injectProbe("once"), "https://studio.decocms.com");
    expect(probe()).toEqual(["once"]);
    second();
  });

  describe("the editor shortcut (editShortcut)", () => {
    function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e;
    }

    it("is on by default", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, false);
      expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("an explicit false turns it off", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO, editShortcut: false }, false);
      expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(false);
      expect(press({ key: "E", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
      expect(open).not.toHaveBeenCalled();
      const html = renderToStaticMarkup(
        <StudioBridge site="shop" trustedOrigins={STUDIO} editShortcut={false} />,
      );
      expect(html.slice(0, html.indexOf(">"))).not.toContain("data-shortcut");
    });

    it("Ctrl+. opens the page in Studio's editor chooser, in a new tab", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO, editShortcut: true }, false);
      expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(true);
      const url = new URL(open.mock.calls[0][0] as string);
      expect(url.origin + url.pathname).toBe("https://studio.decocms.com/choose-editor");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        site: "shop",
        domain: window.location.origin,
        path: window.location.pathname + window.location.search,
        pathTemplate: "/*",
      });
      expect(open.mock.calls[0][1]).toBe("_blank");
    });

    it("leaves typing in a field alone", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO, editShortcut: true }, false);
      const input = document.createElement("input");
      document.body.appendChild(input);
      expect(press({ key: ".", ctrlKey: true }, input).defaultPrevented).toBe(false);
      expect(open).not.toHaveBeenCalled();
      input.remove();
    });

    /** The choose-editor URL a Ctrl+"." opened (a plain "." navigates the tab, which jsdom can't follow). */
    function opened(open: { mock: { calls: unknown[][] } }, call = 0): Record<string, string> {
      const url = new URL(open.mock.calls[call][0] as string);
      expect(url.origin + url.pathname).toBe("https://studio.decocms.com/choose-editor");
      return Object.fromEntries(url.searchParams);
    }

    it('a plain "." on the store page itself (not framed) opens the editor', () => {
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, false);
      const e = press({ key: "." });
      expect(e.defaultPrevented).toBe(true);
      expect(press({ key: "E", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    });

    it("sends the page's path template and id the binding passed", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge(
        {
          site: "shop",
          trustedOrigins: STUDIO,
          page: { pathTemplate: "/:slug/p", id: "pages-pdp-1" },
        },
        false,
      );
      press({ key: ".", metaKey: true });
      expect(opened(open)).toEqual({
        site: "shop",
        domain: window.location.origin,
        pageId: "pages-pdp-1",
        path: window.location.pathname + window.location.search,
        pathTemplate: "/:slug/p",
      });
    });

    it("reads the page at the keypress: a StudioPage on the page wins, the last one rendered", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge(
        { site: "shop", trustedOrigins: STUDIO, page: { pathTemplate: "/from-layout" } },
        false,
      );
      const markers = document.createElement("div");
      document.body.appendChild(markers);
      // A page rendered after the bridge ran (a client-side navigation).
      markers.innerHTML =
        renderToStaticMarkup(<StudioPage pathTemplate="/old" />) +
        renderToStaticMarkup(<StudioPage pathTemplate="/s/:term" id="pages-search" />);
      press({ key: ".", ctrlKey: true });
      expect(opened(open, 0)).toMatchObject({ pathTemplate: "/s/:term", pageId: "pages-search" });
      markers.innerHTML = "";
      press({ key: ".", ctrlKey: true });
      expect(opened(open, 1)).toMatchObject({ pathTemplate: "/from-layout" });
      expect(opened(open, 1)).not.toHaveProperty("pageId");
      markers.remove();
    });

    it("a page template the bridge's attributes change to after it ran is the one sent", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, false);
      const script = document.querySelector("script[data-deco-studio-bridge]") as HTMLElement;
      script.setAttribute("data-path-template", "/category/*");
      press({ key: ".", ctrlKey: true });
      expect(opened(open)).toMatchObject({ pathTemplate: "/category/*" });
    });

    it("StudioPage renders an inert marker, and nothing without a template", () => {
      expect(renderToStaticMarkup(<StudioPage pathTemplate={'/"><x'} id="p" />)).toBe(
        '<template data-deco-page="" data-path-template="/&quot;&gt;&lt;x" data-page-id="p"></template>',
      );
      expect(renderToStaticMarkup(<StudioPage />)).toBe("");
    });

    it('leaves a plain "." typed in any field alone', () => {
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO }, false);
      const fields = [
        document.createElement("input"),
        document.createElement("textarea"),
        document.createElement("select"),
      ];
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      // jsdom doesn't implement isContentEditable.
      Object.defineProperty(editable, "isContentEditable", { value: true });
      for (const field of [...fields, editable]) {
        document.body.appendChild(field);
        expect(press({ key: "." }, field).defaultPrevented).toBe(false);
        field.remove();
      }
    });

    it("is never active inside Studio's frame", () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      unmount = mountBridge({ site: "shop", trustedOrigins: STUDIO, editShortcut: true }, true);
      expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });
  });
});
