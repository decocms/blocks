/**
 * The Studio pieces both bindings render (`StudioBridge` of `@decocms/nextjs`,
 * `DecoDocument` / `DecoPreview` of `@decocms/tanstack`, whose own test,
 * react.test.tsx, checks it mounts exactly these): v8 only, with v7's "."
 * edit shortcut as a script of its own.
 *
 * - Their markup is what a test runner that proxies the site serves as is:
 *   Cypress rewrites "frame-busting" code in the HTML it proxies
 *   (`modifyObstructiveCode`), and a rewrite inside a script that a React
 *   Server Components payload also carries changes that payload's length, so
 *   the page fails to hydrate ("Connection closed."). The regexes below are
 *   Cypress's own (`packages/rewriter/lib/regex-rewriter.ts`, `strip()`), in
 *   both of its modes.
 * - The two bindings carry the same shortcut file (neither imports the other).
 * - The shortcut: "." opens the page in Studio's editor only when the page
 *   isn't framed, and never while the visitor types in a field.
 */
import fs from "node:fs";
import { StudioChannel } from "@decocms/blocks/preview";
import { StudioBridge } from "@decocms/nextjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_BRIDGE_SCRIPT } from "../packages/blocks/src/v8/preview/StudioBridge.ts";
import * as nextShortcut from "../packages/nextjs/src/studioShortcut.ts";

// StudioBridge renders StudioRefresh, which needs the App Router mounted.
vi.mock("next/navigation.js", () => ({ useRouter: () => ({ refresh() {}, replace() {} }) }));

import * as tanstackShortcut from "../packages/tanstack/src/studioShortcut.ts";

// Cypress's regex rewriter (packages/rewriter/lib/regex-rewriter.ts).
const topOrParentEqualityBeforeRe =
  /((?:\bwindow\b|\bself\b)(?:\.|\[['"](?:top|self)['"]\])?\s*[!=]==?\s*(?:(?:window|self)(?:\.|\[['"]))?)(top|parent)(?![\w])/g;
const topOrParentEqualityAfterRe = /(top|parent)((?:["']\])?\s*[!=]==?\s*(?:\bwindow\b|\bself\b))/g;
const topOrParentExpandedEqualityBeforeRe =
  /((?:\bwindow\b|\bself\b|\b[a-zA-z]\.\b)(?:\.|\[['"](?:top|self)['"]\])?\s*[!=]==?\s*(?:(?:window|self|[a-zA-z])(?:\.|\[['"]))?)(top|parent)(?![\w])/g;
const topOrParentExpandedEqualityAfterRe =
  /(top|parent)((?:["']\])?\s*[!=]==?\s*(?:\bwindow\b|\b(?:[a-zA-z]\.)?self\b))/g;
const topWindowLocationRe = /(top)(\.window\.location\s?=)/g;
const topOrParentLocationOrFramesRe =
  /([^\da-zA-Z()])?(\btop\b|\bparent\b)([.])(\blocation\b|\bframes\b)/g;
const jiraTopWindowGetterRe =
  /(!function\s*\((\w{1})\)\s*{\s*return\s*\w{1}\s*(?:={2,})\s*\w{1}\.parent)(\s*}\(\w{1}\))/g;
const jiraTopWindowGetterUnMinifiedRe =
  /(function\s*\w{1,}\s*\((\w{1})\)\s*{\s*return\s*\w{1}\s*(?:={2,})\s*\w{1}\.parent)(\s*;\s*})/g;
const baseTagTargetRe =
  /(<base\b[^>]*?)\s+target\s*=\s*(?:"_(?:top|parent)"|'_(?:top|parent)'|_(?:top|parent)([\s/>]))/gi;

/** Cypress's `strip()` without the integrity rules (the pages here carry no SRI hash). */
function cypressStrip(html: string, thirdParty: boolean): string {
  return html
    .replace(
      thirdParty ? topOrParentExpandedEqualityBeforeRe : topOrParentEqualityBeforeRe,
      "$1self",
    )
    .replace(thirdParty ? topOrParentExpandedEqualityAfterRe : topOrParentEqualityAfterRe, "self$2")
    .replace(topOrParentLocationOrFramesRe, "$1self$3$4")
    .replace(jiraTopWindowGetterRe, "$1 || $2.parent.__Cypress__$3")
    .replace(jiraTopWindowGetterUnMinifiedRe, "$1 || $2.parent.__Cypress__$3")
    .replace(topWindowLocationRe, "$1.window.self.location =")
    .replace(baseTagTargetRe, "$1$2");
}

function expectUntouched(html: string): void {
  expect(cypressStrip(html, false)).toBe(html);
  expect(cypressStrip(html, true)).toBe(html);
}

describe("what a test runner's frame-busting rewrite matches", () => {
  it("catches v7's framed handler (the check works)", () => {
    expect(cypressStrip(STUDIO_BRIDGE_SCRIPT, false)).not.toBe(STUDIO_BRIDGE_SCRIPT);
  });

  it("matches nothing in @decocms/nextjs's StudioBridge", () => {
    const html = renderToStaticMarkup(
      createElement(StudioBridge, {
        site: "acme",
        nonce: "n1",
        page: { pathTemplate: "/:slug/p", id: "pages-pdp" },
      }),
    );
    expect(html).toContain("data-deco-studio-channel");
    expect(html).toContain("data-shortcut");
    expect(html).not.toContain("scrollToComponent");
    expect(html).not.toContain("editor::rerender");
    expectUntouched(html);
  });

  it("matches nothing in @decocms/tanstack's pieces: the shortcut and the channel DecoDocument mounts", () => {
    const html =
      renderToStaticMarkup(
        createElement(tanstackShortcut.StudioShortcut, {
          site: "acme",
          nonce: "n1",
          page: { pathTemplate: "/:slug/p" },
        }),
      ) +
      renderToStaticMarkup(
        createElement(StudioChannel, {
          studioOrigins: ["https://studio.decocms.com", "https://studio-stg.decocms.com"],
          nonce: "n1",
        }),
      );
    expect(html).toContain("data-shortcut");
    expectUntouched(html);
  });
});

it("both bindings carry the same shortcut file", () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  expect(read("../packages/tanstack/src/studioShortcut.ts")).toBe(
    read("../packages/nextjs/src/studioShortcut.ts"),
  );
  expect(tanstackShortcut.STUDIO_SHORTCUT_SCRIPT).toBe(nextShortcut.STUDIO_SHORTCUT_SCRIPT);
});

describe.each([
  ["@decocms/nextjs", nextShortcut.StudioShortcut],
  ["@decocms/tanstack", tanstackShortcut.StudioShortcut],
])("the edit shortcut of %s", (_name, Shortcut) => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  /** Renders the script into the page and runs it as a browser would, framed or not. */
  function mount(props: nextShortcut.StudioShortcutProps, framed = false): void {
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = renderToStaticMarkup(createElement(Shortcut, props));
    const script = host.querySelector("script") as HTMLScriptElement;
    const realParent = window.parent;
    if (framed) Object.defineProperty(window, "parent", { value: {}, configurable: true });
    const added: [string, EventListener][] = [];
    const docAdd = document.addEventListener.bind(document);
    const spy = vi.spyOn(document, "addEventListener").mockImplementation((t, l, o) => {
      added.push([t, l as EventListener]);
      docAdd(t, l, o);
    });
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
    try {
      new Function(script.textContent ?? "")();
    } finally {
      Object.defineProperty(document, "currentScript", { value: null, configurable: true });
      spy.mockRestore();
    }
    cleanup = () => {
      for (const [t, l] of added) document.removeEventListener(t, l);
      Object.defineProperty(window, "parent", { value: realParent, configurable: true });
      delete (window as { __decoStudioShortcut?: boolean }).__decoStudioShortcut;
      host.remove();
    };
  }

  function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
    const e = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    });
    target.dispatchEvent(e);
    return e;
  }

  function opened(open: { mock: { calls: unknown[][] } }, call = 0): Record<string, string> {
    const url = new URL(open.mock.calls[call][0] as string);
    expect(url.origin + url.pathname).toBe("https://studio.decocms.com/choose-editor");
    expect(open.mock.calls[call][1]).toBe("_blank");
    return Object.fromEntries(url.searchParams);
  }

  it("Ctrl+. opens the page in Studio's editor chooser, in a new tab, with the page it was given", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mount({ site: "shop", page: { pathTemplate: "/:slug/p", id: "pages-pdp" } });
    expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(opened(open)).toEqual({
      site: "shop",
      domain: window.location.origin,
      pageId: "pages-pdp",
      path: window.location.pathname + window.location.search,
      pathTemplate: "/:slug/p",
    });
  });

  it('a plain "." and Ctrl+Shift+E on the page itself (not framed) open the editor', () => {
    mount({ site: "shop" });
    expect(press({ key: "." }).defaultPrevented).toBe(true);
    expect(press({ key: "E", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  });

  it("is never active in a frame", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mount({ site: "shop" }, true);
    expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "." }).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("an explicit false turns it off", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mount({ site: "shop", editShortcut: false });
    expect(press({ key: ".", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves typing in a field alone, also in a field inside a shadow root", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mount({ site: "shop" });
    const input = document.body.appendChild(document.createElement("input"));
    expect(press({ key: "." }, input).defaultPrevented).toBe(false);
    input.remove();
    const shadowHost = document.body.appendChild(document.createElement("div"));
    const inner = document.createElement("input");
    shadowHost.attachShadow({ mode: "open" }).appendChild(inner);
    expect(press({ key: "." }, inner).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(press({ key: ".", ctrlKey: true }, shadowHost).defaultPrevented).toBe(true);
    shadowHost.remove();
  });

  it("a StudioPage marker on the page wins, read at the keypress", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mount({ site: "shop", page: { pathTemplate: "/from-layout" } });
    const meta = document.head.appendChild(document.createElement("meta"));
    meta.setAttribute("data-deco-page", "");
    meta.setAttribute("data-path-template", "/s/:term");
    meta.setAttribute("data-page-id", "pages-search");
    press({ key: ".", ctrlKey: true });
    expect(opened(open, 0)).toMatchObject({ pathTemplate: "/s/:term", pageId: "pages-search" });
    meta.remove();
    press({ key: ".", ctrlKey: true });
    expect(opened(open, 1)).toMatchObject({ pathTemplate: "/from-layout" });
  });
});
