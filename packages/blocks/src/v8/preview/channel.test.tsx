// @vitest-environment jsdom
import { gzipSync } from "node:zlib";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineStudioModule, type StudioChannelContext } from "../../protocol/channel.ts";
import { STUDIO_CHANNEL_SCRIPT, StudioChannel } from "./StudioChannel.ts";

const STUDIO = "https://studio.decocms.com";
const STAGING = "https://studio-stg.decocms.com";
/** What a binding passes by default: Studio's production and staging origins. */
const ORIGINS = [STUDIO, STAGING];
const MODULE = `${STUDIO}/_modules/v1/wireframe.js`;

type Importer = (url: string) => Promise<unknown>;
const G = globalThis as { __decoTestImport?: Importer; __decoTestAncestors?: unknown };

/**
 * Runs the bootstrap the way a browser does: the server-rendered script as
 * `document.currentScript`, its text evaluated once, with `import()` routed
 * to `importer` (jsdom can't fetch a module) and `location.ancestorOrigins`
 * to `ancestors` (jsdom has none, as Firefox).
 */
function mount(
  studioOrigins: readonly string[],
  framed: boolean,
  importer: Importer = vi.fn(),
  ancestors?: string[],
) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<StudioChannel studioOrigins={studioOrigins} />);
  const script = host.querySelector("script") as HTMLScriptElement;
  document.body.appendChild(host);
  const realParent = window.parent;
  const frame = framed ? document.createElement("iframe") : null;
  if (frame) document.body.appendChild(frame);
  const parent = (frame?.contentWindow ?? window) as Window;
  const posted = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
  if (framed) Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const listeners: EventListener[] = [];
  const add = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, "addEventListener").mockImplementation((t, l, o) => {
    listeners.push(l as EventListener);
    add(t, l, o);
  });
  G.__decoTestImport = importer;
  G.__decoTestAncestors = ancestors;
  const source = STUDIO_CHANNEL_SCRIPT.replace(
    "import(h)",
    "globalThis.__decoTestImport(h)",
  ).replace("w.location.ancestorOrigins", "globalThis.__decoTestAncestors");
  expect(source).not.toContain("import(h)");
  expect(source).not.toContain("location.ancestorOrigins");
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  try {
    new Function(source)();
  } finally {
    Object.defineProperty(document, "currentScript", { value: null, configurable: true });
    spy.mockRestore();
  }
  const post = (data: unknown, origin = STUDIO, from: Window | null = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: from }));
  const unmount = () => {
    for (const l of listeners) window.removeEventListener("message", l);
    Object.defineProperty(window, "parent", { value: realParent, configurable: true });
    delete (window as { __decoStudioChannel?: boolean }).__decoStudioChannel;
    posted.mockRestore();
    frame?.remove();
    host.remove();
  };
  return { posted, post, listeners, unmount };
}

const READY = { type: "deco:ready" };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("StudioChannel", () => {
  let unmount: (() => void) | undefined;
  afterEach(() => {
    unmount?.();
    unmount = undefined;
    delete G.__decoTestImport;
    delete G.__decoTestAncestors;
    vi.restoreAllMocks();
  });

  it("renders one static script; Studio's origins are an attribute, normalized, invalid ones dropped", () => {
    const html = renderToStaticMarkup(
      <StudioChannel studioOrigins={[`${STUDIO}/`, STAGING, STUDIO]} nonce="n0" />,
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.children).toHaveLength(1);
    const script = host.querySelector("script") as HTMLScriptElement;
    expect(JSON.parse(script.getAttribute("data-studio-origins") ?? "")).toEqual(ORIGINS);
    expect(script.getAttribute("nonce")).toBe("n0");
    expect(script.textContent).toBe(STUDIO_CHANNEL_SCRIPT);
    const bad = [
      "",
      "studio.decocms.com",
      "https://studio.decocms.com/x",
      "https://*.decocms.com",
      "javascript:x",
      "'unsafe-inline'",
    ];
    const off = renderToStaticMarkup(<StudioChannel studioOrigins={bad} />);
    expect(off).toContain('data-studio-origins="[]"');
    const other = renderToStaticMarkup(
      <StudioChannel studioOrigins={["http://localhost:4000", ...bad]} />,
    );
    expect(other).toContain('data-studio-origins="[&quot;http://localhost:4000&quot;]"');
    expect(other.slice(other.indexOf(">"))).toBe(html.slice(html.indexOf(">")));
  });

  it("posts deco:ready to each trusted origin as the targetOrigin (the browser drops the others)", () => {
    const page = mount(ORIGINS, true);
    unmount = page.unmount;
    expect(page.posted.mock.calls).toEqual([
      [READY, STUDIO],
      [READY, STAGING],
    ]);
  });

  it("where the browser names the parent's origin, posts deco:ready to it alone, and only if trusted", () => {
    const staging = mount(ORIGINS, true, vi.fn(), [STAGING, "https://elsewhere.example"]);
    expect(staging.posted.mock.calls).toEqual([[READY, STAGING]]);
    staging.unmount();
    const evil = mount(ORIGINS, true, vi.fn(), ["https://evil.example"]);
    unmount = evil.unmount;
    expect(evil.posted).not.toHaveBeenCalled();
  });

  it("framed by Studio: posts deco:ready, loads the module, then relays messages both ways", async () => {
    const received: unknown[] = [];
    let channel: StudioChannelContext | undefined;
    const start = vi.fn(
      defineStudioModule((context) => {
        channel = context;
        context.on((message) => received.push(message));
      }),
    );
    const importer = vi.fn(async () => ({ default: start }));
    const page = mount(ORIGINS, true, importer);
    unmount = page.unmount;
    page.posted.mockClear();

    page.post({ type: "deco:load", url: MODULE });
    await flush();
    expect(importer).toHaveBeenCalledWith(MODULE);
    expect(start).toHaveBeenCalledTimes(1);
    expect(channel?.studioOrigin).toBe(STUDIO);
    expect(channel?.url).toBe(MODULE);
    expect(page.posted.mock.calls.at(-1)).toEqual([{ type: "deco:loaded", url: MODULE }, STUDIO]);

    // Module messages reach the module; the channel's own (deco:*) never do.
    page.post({ type: "wireframe:select", id: "s1" });
    page.post({ type: "deco:ready" });
    expect(received).toEqual([{ type: "wireframe:select", id: "s1" }]);
    channel?.send({ type: "wireframe:hovered" });
    expect(page.posted.mock.calls.at(-1)).toEqual([{ type: "wireframe:hovered" }, STUDIO]);
  });

  it("a listener can unsubscribe, and one that throws doesn't stop the others", async () => {
    const seen: string[] = [];
    let off: (() => void) | undefined;
    const importer = vi.fn(async () => ({
      default: (context: StudioChannelContext) => {
        off = context.on(() => seen.push("a"));
        context.on(() => {
          throw new Error("boom");
        });
        context.on(() => seen.push("c"));
      },
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = mount(ORIGINS, true, importer);
    unmount = page.unmount;
    page.post({ type: "deco:load", url: MODULE });
    await flush();
    page.post({ type: "x" });
    off?.();
    page.post({ type: "x" });
    expect(seen).toEqual(["a", "c", "c"]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("ignores a message whose event.origin isn't exactly one of the trusted origins", async () => {
    const importer = vi.fn(async () => ({ default: () => {} }));
    const page = mount(ORIGINS, true, importer);
    unmount = page.unmount;
    page.posted.mockClear();
    for (const origin of [
      "https://evil.example",
      "https://decocms.com",
      "https://admin.decocms.com",
      "http://studio.decocms.com",
      "https://studio.decocms.com:8443",
      "https://studio.decocms.com/",
      "https://studio.decocms.com.evil.example",
      "null",
      "",
    ]) {
      page.post({ type: "deco:load", url: MODULE }, origin);
    }
    await flush();
    expect(importer).not.toHaveBeenCalled();
    expect(page.posted).not.toHaveBeenCalled();
  });

  it("a list that names only production ignores staging; one replaced by the binding trusts only its own", async () => {
    const importer = vi.fn(async () => ({ default: () => {} }));
    const prod = mount([STUDIO], true, importer);
    expect(prod.posted.mock.calls).toEqual([[READY, STUDIO]]);
    prod.post({ type: "deco:load", url: `${STAGING}/_modules/v1/wireframe.js` }, STAGING);
    await flush();
    expect(importer).not.toHaveBeenCalled();
    prod.unmount();

    const local = mount(["http://localhost:3000"], true, importer);
    unmount = local.unmount;
    expect(local.posted.mock.calls).toEqual([[READY, "http://localhost:3000"]]);
    local.post({ type: "deco:load", url: MODULE }, STUDIO);
    local.post({ type: "deco:load", url: "http://localhost:3000/m.js" }, "http://localhost:3000");
    await flush();
    expect(importer.mock.calls).toEqual([["http://localhost:3000/m.js"]]);
  });

  it("loads a module only from the origin of the message that asked for it, and binds the module to it", async () => {
    const seen: unknown[] = [];
    let channel: StudioChannelContext | undefined;
    const importer = vi.fn(async () => ({
      default: (context: StudioChannelContext) => {
        channel = context;
        context.on((m) => seen.push(m));
      },
    }));
    const page = mount(ORIGINS, true, importer);
    unmount = page.unmount;
    // Both origins are trusted, but a message from one never names a module on the other.
    page.post({ type: "deco:load", url: MODULE }, STAGING);
    page.post({ type: "deco:load", url: `${STAGING}/_modules/v1/wireframe.js` }, STUDIO);
    await flush();
    expect(importer).not.toHaveBeenCalled();

    page.posted.mockClear();
    const staged = `${STAGING}/_modules/v1/wireframe.js`;
    page.post({ type: "deco:load", url: staged }, STAGING);
    await flush();
    expect(importer.mock.calls).toEqual([[staged]]);
    expect(channel?.studioOrigin).toBe(STAGING);
    expect(page.posted.mock.calls).toEqual([[{ type: "deco:loaded", url: staged }, STAGING]]);
    channel?.send({ type: "wireframe:hovered" });
    expect(page.posted.mock.calls.at(-1)).toEqual([{ type: "wireframe:hovered" }, STAGING]);
    // The module hears its own origin only.
    page.post({ type: "wireframe:select", id: "prod" }, STUDIO);
    page.post({ type: "wireframe:select", id: "stg" }, STAGING);
    expect(seen).toEqual([{ type: "wireframe:select", id: "stg" }]);
  });

  it("ignores a Studio-origin message that doesn't come from the parent window", async () => {
    const importer = vi.fn(async () => ({ default: () => {} }));
    const page = mount(ORIGINS, true, importer);
    unmount = page.unmount;
    page.post({ type: "deco:load", url: MODULE }, STUDIO, window);
    page.post({ type: "deco:load", url: MODULE }, STUDIO, null);
    await flush();
    expect(importer).not.toHaveBeenCalled();
  });

  it("ignores a module URL on any other origin, or one that isn't an absolute URL", async () => {
    const importer = vi.fn(async () => ({ default: () => {} }));
    const page = mount(ORIGINS, true, importer);
    unmount = page.unmount;
    for (const url of [
      "https://evil.example/wireframe.js",
      "https://studio.decocms.com.evil.example/x.js",
      "http://studio.decocms.com/x.js",
      "//evil.example/x.js",
      "/_modules/v1/wireframe.js",
      "data:text/javascript,alert(1)",
      "javascript:alert(1)",
      42,
      undefined,
    ]) {
      page.post({ type: "deco:load", url });
    }
    page.post(null);
    page.post("deco:load");
    await flush();
    expect(importer).not.toHaveBeenCalled();
    expect(page.posted).toHaveBeenCalledTimes(ORIGINS.length);
  });

  it("does nothing when the page isn't framed", async () => {
    const importer = vi.fn(async () => ({ default: () => {} }));
    const page = mount(ORIGINS, false, importer);
    unmount = page.unmount;
    expect(page.listeners).toEqual([]);
    expect(page.posted).not.toHaveBeenCalled();
    page.post({ type: "deco:load", url: MODULE }, STUDIO, window);
    await flush();
    expect(importer).not.toHaveBeenCalled();
  });

  it("does nothing with no valid Studio origin", () => {
    const page = mount(["not an origin", "https://*.decocms.com"], true);
    unmount = page.unmount;
    expect(page.listeners).toEqual([]);
    expect(page.posted).not.toHaveBeenCalled();
  });

  it("loads each URL once; a failed load is reported and may be retried", async () => {
    const start = vi.fn();
    let fail = true;
    const importer = vi.fn(async (url: string): Promise<unknown> => {
      if (url.endsWith("broken.js") && fail) throw new Error("404");
      return { default: start };
    });
    const page = mount(ORIGINS, true, importer);
    unmount = page.unmount;
    page.post({ type: "deco:load", url: MODULE });
    page.post({ type: "deco:load", url: MODULE });
    await flush();
    page.post({ type: "deco:load", url: MODULE });
    await flush();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    const broken = `${STUDIO}/_modules/v1/broken.js`;
    page.post({ type: "deco:load", url: broken });
    await flush();
    expect(page.posted.mock.calls.at(-1)).toEqual([
      { type: "deco:load-error", url: broken, message: "404" },
      STUDIO,
    ]);
    fail = false;
    page.post({ type: "deco:load", url: broken });
    await flush();
    expect(page.posted.mock.calls.at(-1)).toEqual([{ type: "deco:loaded", url: broken }, STUDIO]);

    // A module with no default export is a load error too.
    const empty = `${STUDIO}/_modules/v1/empty.js`;
    importer.mockImplementationOnce(async () => ({}));
    page.post({ type: "deco:load", url: empty });
    await flush();
    expect(page.posted.mock.calls.at(-1)?.[0]).toMatchObject({ type: "deco:load-error" });
  });

  it("runs once when rendered twice", async () => {
    const page = mount(ORIGINS, true);
    unmount = page.unmount;
    const script = document.createElement("script");
    script.setAttribute("data-studio-origins", JSON.stringify(ORIGINS));
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
    new Function(STUDIO_CHANNEL_SCRIPT)();
    Object.defineProperty(document, "currentScript", { value: null, configurable: true });
    expect(page.posted).toHaveBeenCalledTimes(ORIGINS.length);
  });

  it("stays small: it ships inline in every page, production included", () => {
    // 1.4 kB raw, about 0.7 kB gzipped, in each page's HTML; no client JS.
    expect(STUDIO_CHANNEL_SCRIPT.length).toBeLessThan(1450);
    expect(gzipSync(STUDIO_CHANNEL_SCRIPT).length).toBeLessThan(760);
  });
});
