// @vitest-environment node
/**
 * `decoContent()` (`@decocms/blocks/vite`) and `adoptContent`: in `vite dev`,
 * a saved block reaches the CMS without re-running the module that created
 * it, and open pages reload only after that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptContent, createCMS, instanceOf, resetForTests } from "../cms";
import type { Snapshot } from "../types";
import { CONTENT_UPDATED_EVENT, contentModuleFooter, decoContent, isContentModule } from "./index";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetForTests();
});

const blocks = { seo: (props: { title: string }) => props };

function content(title: string, root = ".deco"): Snapshot {
  return {
    revision: `r-${title}`,
    blocks: { S: { __resolveType: "seo", title } },
    root,
  } as Snapshot;
}

describe("adoptContent", () => {
  it("hands the new module to the CMS of its .deco folder, keeping the instance", async () => {
    const cms = createCMS({ blocks, content: content("one") });
    const instance = instanceOf(cms);
    expect(adoptContent(content("two"))).toBe(1);
    expect(await cms.forRelease().resolve("S")).toEqual([{ title: "two" }, null]);
    expect(instanceOf(createCMS({ blocks, content: content("three") }))).toBe(instance);
  });

  it("leaves the CMS of another .deco folder alone", async () => {
    const cms = createCMS({ blocks, content: content("one", "apps/a/.deco") });
    expect(adoptContent(content("two", "apps/b/.deco"))).toBe(0);
    expect(await cms.forRelease().resolve("S")).toEqual([{ title: "one" }, null]);
  });

  it("keeps the instance's own options: a hosted CMS keeps its site", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const cms = createCMS({ blocks, content: content("one"), site: "acme", dev: true });
    expect(adoptContent(content("two"))).toBe(1);
    expect(await cms.forRelease().resolve("S")).toEqual([{ title: "two" }, null]);
    expect(instanceOf(createCMS({ blocks, content: content("x"), site: "acme", dev: true }))).toBe(
      instanceOf(cms),
    );
  });

  it("adopts nothing before a CMS exists, or for a module without a root", () => {
    expect(adoptContent(content("one"))).toBe(0);
    createCMS({ blocks, content: content("one") });
    const rootless = { revision: "r", blocks: {} };
    expect(adoptContent(rootless)).toBe(0);
    expect(adoptContent("nope" as unknown as Snapshot)).toBe(0);
  });
});

describe("decoContent", () => {
  type Transform = (
    this: unknown,
    code: string,
    id: string,
    options?: { ssr?: boolean },
  ) => { code: string; map: null } | null;
  const plugin = decoContent();
  const transform = plugin.transform as unknown as Transform;
  const server = { environment: { config: { consumer: "server" } } };
  const client = { environment: { config: { consumer: "client" } } };
  const source = "const content = {};\nexport default content;\n";

  it("runs only in vite dev", () => {
    expect(plugin.apply).toBe("serve");
    expect(plugin.name).toBe("decocms:content");
  });

  it("matches only a site's .deco/blocks.gen.ts", () => {
    expect(isContentModule("/site/.deco/blocks.gen.ts")).toBe(true);
    expect(isContentModule("/site/.deco/blocks.gen.ts?v=123")).toBe(true);
    expect(isContentModule("C:\\site\\.deco\\blocks.gen.ts")).toBe(true);
    expect(isContentModule("/site/.deco/index.ts")).toBe(false);
    expect(isContentModule("/site/.deco/blocks/Home.json")).toBe(false);
    expect(isContentModule("/site/src/blocks.gen.ts")).toBe(false);
    expect(isContentModule("/site/node_modules/x/.deco/blocks.gen.ts")).toBe(false);
  });

  it("appends the footer to the content module in a server environment only", () => {
    const id = "/site/.deco/blocks.gen.ts";
    expect(transform.call(server, source, id)).toEqual({
      code: source + contentModuleFooter(),
      map: null,
    });
    expect(transform.call(client, source, id)).toBeNull();
    expect(transform.call(server, source, "/site/src/cms.ts")).toBeNull();
    // Without the Environment API (no this.environment), the ssr flag decides.
    expect(transform.call({}, source, id, { ssr: true })?.code).toBe(
      source + contentModuleFooter(),
    );
    expect(transform.call({}, source, id, { ssr: false })).toBeNull();
  });

  it("the footer accepts its own update, adopts the new module, then sends the event", () => {
    const footer = contentModuleFooter();
    expect(footer).toContain('from "@decocms/blocks/vite/hot"');
    expect(footer).toContain("import.meta.hot.accept((next) =>");
    const adopt = footer.indexOf("__decoAdoptContent(next.default)");
    const send = footer.indexOf(`import.meta.hot?.send(${JSON.stringify(CONTENT_UPDATED_EVENT)})`);
    expect(adopt).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(adopt);
    // Appended: the generated lines keep their positions.
    expect(footer.startsWith("\n")).toBe(true);
  });

  it("turns the event from any server environment into a full reload of the client", () => {
    const listeners = new Map<string, () => void>();
    const hot = (name: string) => ({
      on: (event: string, listener: () => void) => listeners.set(`${name}:${event}`, listener),
      send: vi.fn(),
    });
    const environments = {
      client: { config: { consumer: "client" }, hot: hot("client") },
      ssr: { config: { consumer: "server" }, hot: hot("ssr") },
      rsc: { config: { consumer: "server" }, hot: hot("rsc") },
    };
    const configureServer = plugin.configureServer as unknown as (server: unknown) => void;
    configureServer({ environments });
    expect([...listeners.keys()].sort()).toEqual([
      `rsc:${CONTENT_UPDATED_EVENT}`,
      `ssr:${CONTENT_UPDATED_EVENT}`,
    ]);
    vi.useFakeTimers();
    try {
      // A save swaps the module twice (the block's JSON, then the content module): one reload.
      listeners.get(`rsc:${CONTENT_UPDATED_EVENT}`)?.();
      listeners.get(`ssr:${CONTENT_UPDATED_EVENT}`)?.();
      expect(environments.client.hot.send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(environments.client.hot.send).toHaveBeenCalledTimes(1);
      expect(environments.client.hot.send).toHaveBeenCalledWith({ type: "full-reload" });
    } finally {
      vi.useRealTimers();
    }
  });
});
