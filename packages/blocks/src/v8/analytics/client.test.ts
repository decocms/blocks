// @vitest-environment jsdom
/**
 * `@decocms/blocks/analytics/client`: a v8 site running the Deco Analytics client
 * without the external tag. It must collect what the tag collects, by itself, and
 * send it to the collector in the same wire format, because both run the same files.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WIRE } from "./shared/contract.ts";

type Event = Record<string, unknown>;
type Api = Record<string, (...args: any[]) => unknown>;
type Post = { url: string; body: { site: string; key?: string; events: Event[] } };

const here = dirname(fileURLToPath(import.meta.url));
const w = window as unknown as Record<string, any>;
let posts: Post[] = [];

const events = () => posts.flatMap((p) => p.body.events);
const names = () => events().map((e) => e[WIRE.name]);

/** A fresh page: the client's globals gone and a fresh copy of every module. */
beforeEach(() => {
  vi.resetModules();
  for (const k of ["__dq", "__dqBooted", "__dqRegister", "__dqCid"]) delete w[k];
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const start = async (options: Record<string, unknown> = {}) => {
  const { startAnalytics } = await import("./client.ts");
  // `dev`: jsdom's page is on localhost, which the client rightly skips otherwise.
  return (await startAnalytics({ dev: true, ...options })) as Api | null;
};

describe("startAnalytics", () => {
  it("collects a page view by itself and sends it to /_dq/e on the page's own host", async () => {
    const api = await start();
    expect(typeof api?.track).toBe("function");
    expect(posts).toHaveLength(1);
    // Relative, so the collector resolves the site from this page's Host (rule 1).
    expect(posts[0].url).toBe("/_dq/e");
    expect(posts[0].body.events[0]).toMatchObject({
      [WIRE.name]: "$pageview",
      [WIRE.path]: location.pathname,
    });
  });

  it("counts a client-side navigation as a page view, with no track() call", async () => {
    const api = await start();
    history.pushState({}, "", "/category/shoes");
    api!.flush();
    expect(
      events()
        .filter((e) => e[WIRE.name] === "$pageview")
        .map((e) => e[WIRE.path]),
    ).toEqual(["/", "/category/shoes"]);
    history.pushState({}, "", "/");
  });

  it("loads the modules it is given, after core, and they collect by themselves", async () => {
    const api = await start({ modules: ["click", "commerce"] });
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    api!.addToCart({ value: 10, currency: "BRL", itemIds: ["sku-1"] });
    api!.flush();
    expect(names()).toEqual(["$pageview", "experiment_click", "add_to_cart"]);
    expect(events()[2]).toMatchObject({ [WIRE.value]: 10, [WIRE.currency]: "BRL" });
  });

  it("delivers a helper the page queued before it started, once that helper's module is in", async () => {
    w.__dq = { q: [{ m: "addToCart", a: [{ value: 5 }] }] };
    const api = await start({ modules: ["commerce"] });
    api!.flush();
    expect(names()).toEqual(["$pageview", "add_to_cart"]);
  });

  it("passes the site's settings to core the way the collector's bundle does", async () => {
    await start({ key: "dq_SiteKey000000000000000", endpoint: "https://collector.example/_dq/e" });
    expect(posts[0].url).toBe("https://collector.example/_dq/e");
    expect(posts[0].body.key).toBe("dq_SiteKey000000000000000");
  });

  it("puts the tests the page rendered on every event, the first page view included", async () => {
    const api = await start({
      experiments: { "hero-copy": true, "buy-button": false },
      modules: ["click"],
    });
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    api!.flush();
    expect(names()).toEqual(["$pageview", "experiment_click"]);
    for (const event of events()) {
      expect(event[WIRE.exp]).toEqual({ "hero-copy": "on", "buy-button": "off" });
    }
    // Only the decision travels: the beacon has no other new field.
    for (const post of posts) expect(Object.keys(post.body)).toEqual(["site", "events"]);
  });

  it("keeps another script's tests on the page, and the rendered arm wins a shared name", async () => {
    w.__dq = { x: { "ab-sdk-test": "verde", "hero-copy": "off" } };
    await start({ experiments: { "hero-copy": true } });
    expect(events()[0][WIRE.exp]).toEqual({ "ab-sdk-test": "verde", "hero-copy": "on" });
  });

  it("sends no exp without experiments, so other sites' events are unchanged", async () => {
    await start({ experiments: {} });
    expect(events()[0][WIRE.exp]).toBeUndefined();
  });

  it("leaves the external tag alone when it booted first: one client per page", async () => {
    const track = vi.fn();
    w.__dqBooted = true;
    w.__dq = { track };
    const api = await start({ modules: ["click"] });
    expect(api?.track).toBe(track);
    expect(posts).toEqual([]);
  });

  it("hands the tests to the tag when the tag booted first", async () => {
    const setExperiment = vi.fn();
    w.__dqBooted = true;
    w.__dq = { track: vi.fn(), setExperiment };
    await start({ experiments: { "hero-copy": true, "buy-button": false } });
    expect(setExperiment.mock.calls).toEqual([
      ["hero-copy", "on"],
      ["buy-button", "off"],
    ]);
  });

  it("collects nothing, and loads no module, when collection is off for this visitor", async () => {
    const { startAnalytics } = await import("./client.ts");
    // A development host without `dev`: the same skip the tag applies.
    expect(await startAnalytics({ modules: ["click"] })).toBeNull();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posts).toEqual([]);
    expect(w.__dq.track).toBeUndefined();
  });
});

describe("the same events as the standalone tag", () => {
  const out = mkdtempSync(join(tmpdir(), "dq-client-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const esbuildBin = join(here, "../../../../../node_modules/.bin/esbuild");

  /** The bundle decocms/analytics serves as `/_dq/a.js` for a site with `click`: core, then the module. */
  function standalone(): string {
    return ["runtime/src/index.ts", "runtime/modules/click.ts"]
      .map((entry) => {
        const file = join(out, entry.replaceAll("/", "_"));
        execFileSync(esbuildBin, [
          join(here, entry),
          "--bundle",
          "--format=iife",
          "--minify",
          "--target=es2020",
          `--outfile=${file}.js`,
          "--log-level=warning",
        ]);
        return readFileSync(`${file}.js`, "utf-8");
      })
      .join("\n");
  }

  /** The keys of each event, the values that don't vary by run (`event_id`, `ts`) left out. */
  const shape = (es: Event[]) =>
    es.map((e) => {
      const { [WIRE.event_id]: _id, [WIRE.ts]: _ts, ...rest } = e;
      return rest;
    });

  it("a page view and a click reach the collector identically from either", async () => {
    const api = await start({ modules: ["click"] });
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    api!.flush();
    const native = posts.map((p) => ({ ...p.body, events: shape(p.body.events) }));

    const dom = new JSDOM("<!doctype html><body></body>", {
      url: location.href,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    const tagPosts: Post["body"][] = [];
    dom.window.fetch = (async (_url: string, init: RequestInit) => {
      tagPosts.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }) as never;
    dom.window.eval(`window.__dq={s:"unknown",e:"/_dq/e",r:1,tier:0,dev:true};${standalone()}`);
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    dom.window.__dq.flush();
    dom.window.close();

    expect(native).toEqual(tagPosts.map((b) => ({ ...b, events: shape(b.events) })));
    expect(native.flatMap((b) => b.events).map((e) => e[WIRE.name])).toEqual([
      "$pageview",
      "experiment_click",
    ]);
  });
});
