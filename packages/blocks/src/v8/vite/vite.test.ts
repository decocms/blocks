// @vitest-environment node
/**
 * `decoContent()` (`@decocms/blocks/vite`) and `adoptContent`: in `vite dev`,
 * the module that imports the content module accepts its updates, a saved
 * block reaches the CMS without re-running any module, and open pages reload
 * only after that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptContent, createCMS, instanceOf, resetForTests } from "../cms";
import type { Snapshot } from "../types";
import {
  acceptedSpecifiers,
  CONTENT_UPDATED_EVENT,
  decoContent,
  importerFooter,
  isContentModule,
  staticImports,
} from "./index";

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
  ) => Promise<{ code: string; map: null } | null>;
  const plugin = decoContent();
  const transform = plugin.transform as unknown as Transform;

  it("runs only in vite dev", () => {
    expect(plugin.apply).toBe("serve");
    expect(plugin.name).toBe("decocms:content");
  });

  it("pre-bundles the footer's import in the server environments only", () => {
    type ConfigEnvironment = (name: string, config: { consumer?: string }) => unknown;
    const configEnvironment = plugin.configEnvironment as unknown as ConfigEnvironment;
    const include = { optimizeDeps: { include: ["@decocms/blocks/vite/hot"] } };
    expect(configEnvironment("ssr", {})).toEqual(include);
    expect(configEnvironment("worker", { consumer: "server" })).toEqual(include);
    expect(configEnvironment("client", {})).toBeUndefined();
    expect(configEnvironment("browser", { consumer: "client" })).toBeUndefined();
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

  it("reads static imports and re-exports, not dynamic imports", () => {
    const code = [
      'import content from "../.deco/blocks.gen";',
      "import { a,\n  b } from './x.ts';",
      'import * as all from "~/y";',
      'import "./side-effect";',
      'export { c } from "./z";',
      'const later = import("./dynamic");',
      "const meta = import.meta.env;",
    ].join("\n");
    expect(staticImports(code)).toEqual([
      "../.deco/blocks.gen",
      "./x.ts",
      "~/y",
      "./side-effect",
      "./z",
    ]);
  });

  it("reads the dependencies a module accepts by hand", () => {
    expect(acceptedSpecifiers('import.meta.hot.accept("../.deco/blocks.gen", (n) => n);')).toEqual([
      "../.deco/blocks.gen",
    ]);
    expect(acceptedSpecifiers("hot.accept(['./a', \"./b\"], cb)")).toEqual(["./a", "./b"]);
    expect(acceptedSpecifiers("import.meta.hot.accept((next) => next)")).toEqual([]);
  });

  describe("transform", () => {
    const gen = "/site/.deco/blocks.gen.ts";
    // A resolver like Vite's: relative, aliased and extensionless forms of the content module.
    const resolve = vi.fn(async (specifier: string) => {
      if (/(^|\/)\.deco\/blocks\.gen(\.ts)?$/.test(specifier) || specifier === "@content") {
        return { id: gen, external: false };
      }
      if (specifier === "missing") return null;
      return { id: `/site/src/${specifier.replace(/^\W+/, "")}.ts`, external: false };
    });
    const ctx = (consumer?: string) => ({
      environment: consumer ? { config: { consumer } } : undefined,
      resolve,
    });
    const site =
      'import { createCMS } from "@decocms/blocks";\nimport content from "../.deco/blocks.gen";\n';

    it("makes an importer of the content module accept its updates, in a server environment", async () => {
      expect(await transform.call(ctx("server"), site, "/site/src/cms.ts")).toEqual({
        code: site + importerFooter("../.deco/blocks.gen"),
        map: null,
      });
      for (const specifier of ["~/.deco/blocks.gen", "../.deco/blocks.gen.ts", "@content"]) {
        const code = `import content from ${JSON.stringify(specifier)};\n`;
        expect((await transform.call(ctx("server"), code, "/site/src/cms.ts"))?.code).toBe(
          code + importerFooter(specifier),
        );
      }
      // Without the Environment API (no this.environment), the ssr flag decides.
      expect((await transform.call(ctx(), site, "/site/src/cms.ts", { ssr: true }))?.code).toBe(
        site + importerFooter("../.deco/blocks.gen"),
      );
      expect(await transform.call(ctx(), site, "/site/src/cms.ts", { ssr: false })).toBeNull();
    });

    it("leaves the client, the content module itself, dependencies and other modules alone", async () => {
      expect(await transform.call(ctx("client"), site, "/site/src/cms.ts")).toBeNull();
      expect(await transform.call(ctx("server"), "export default {};\n", gen)).toBeNull();
      expect(await transform.call(ctx("server"), site, "/site/node_modules/x/cms.js")).toBeNull();
      expect(await transform.call(ctx("server"), site, "/site/src/style.css")).toBeNull();
      const other = 'import { x } from "./x";\nimport y from "missing";\n';
      expect(await transform.call(ctx("server"), other, "/site/src/a.ts")).toBeNull();
    });

    it("leaves a module that accepts the content module's updates by hand as it is", async () => {
      const legacy = `${site}if (import.meta.hot) {\n  import.meta.hot.accept("../.deco/blocks.gen", () => {});\n}\n`;
      expect(await transform.call(ctx("server"), legacy, "/site/src/cms.ts")).toBeNull();
      // Accepting something else doesn't count.
      const unrelated = `${site}import.meta.hot?.accept("./x", () => {});\n`;
      expect((await transform.call(ctx("server"), unrelated, "/site/src/cms.ts"))?.code).toBe(
        unrelated + importerFooter("../.deco/blocks.gen"),
      );
    });
  });

  it("the footer accepts the import's update, adopts the new module, then sends the event", () => {
    const footer = importerFooter("../.deco/blocks.gen");
    expect(footer).toContain('from "@decocms/blocks/vite/hot"');
    expect(footer).toContain('import.meta.hot.accept("../.deco/blocks.gen", (next) =>');
    const adopt = footer.indexOf("__decoAdoptContent(next.default)");
    const send = footer.indexOf(`import.meta.hot?.send(${JSON.stringify(CONTENT_UPDATED_EVENT)})`);
    expect(adopt).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(adopt);
    // Appended: the module's lines keep their positions.
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
