import { describe, expect, it } from "vitest";
import { decoVitePlugin } from "./plugin.js";

/**
 * Permanent regression test for the site-action/loader bundle leak.
 *
 * `.deco/loaders.gen.ts` registers every site loader/action behind a dynamic
 * `import()` and is reachable from the CLIENT entry (router -> setup ->
 * commerce-loaders -> loaders.gen). Without the client stub, Vite emits each
 * loader/action module as a public client chunk, leaking the module source
 * (including any hardcoded credential in it) into the browser assets.
 *
 * The load() hook must replace loaders.gen.ts with an empty `siteLoaders` on
 * the client so those dynamic imports vanish from the client graph, while SSR
 * keeps the real module (invoke runs server-side only). If this ever regresses,
 * a token hardcoded in a site action becomes publicly downloadable again.
 */
describe("decoVitePlugin — loaders.gen client stub", () => {
  // The plugin's load hook is a plain function that uses no `this`.
  const plugin = decoVitePlugin() as {
    load: (id: string, options?: { ssr?: boolean }) => string | undefined;
  };
  const id = "/repo/.deco/loaders.gen.ts";

  it("stubs loaders.gen.ts to an empty siteLoaders in the CLIENT build", () => {
    const out = plugin.load(id, { ssr: false });
    expect(out).toBe("export const siteLoaders = {};");
    // The stub must carry no dynamic import — that's the whole point.
    expect(out).not.toMatch(/import\s*\(/);
  });

  it("leaves loaders.gen.ts untouched in the SSR build (real registry)", () => {
    expect(plugin.load(id, { ssr: true })).toBeUndefined();
  });

  it("defaults to the client (stubbed) behavior when ssr is unset", () => {
    // Rollup/Vite may call load() without an options.ssr flag; the guard is
    // `!options?.ssr`, so an absent flag must be treated as client.
    expect(plugin.load(id)).toBe("export const siteLoaders = {};");
    expect(plugin.load(id, {})).toBe("export const siteLoaders = {};");
  });

  it("still stubs blocks.gen.ts on the client (existing behavior intact)", () => {
    const out = plugin.load("/repo/.deco/blocks.gen.ts", { ssr: false });
    expect(out).toBe("export const blocks = {};");
  });

  it("does not touch unrelated modules", () => {
    expect(plugin.load("/repo/src/sections/Hero.tsx", { ssr: false })).toBeUndefined();
    expect(plugin.load("/repo/src/actions/foo.ts", { ssr: false })).toBeUndefined();
  });
});

/**
 * `fastDeploy: true` must stub blocks.gen out of the SERVER bundle too.
 *
 * Otherwise a fast-deploy site holds the decofile twice: the bundled
 * JSON.parse(...) graph stays reachable via the site's `import { blocks }`
 * binding for the isolate's whole life, and ensureBlocksHydrated adds a
 * second graph. Tens of MB of avoidable memory for a 10MB decofile.
 */
describe("decoVitePlugin — fastDeploy server stub", () => {
  const id = "/repo/.deco/blocks.gen.ts";
  const STUB = "export const blocks = {};";

  it("stubs blocks.gen on SSR when fastDeploy is on", () => {
    const plugin = decoVitePlugin({ fastDeploy: true }) as {
      load: (id: string, options?: { ssr?: boolean }) => string | undefined;
    };
    expect(plugin.load(id, { ssr: true })).toBe(STUB);
  });

  it("keeps stubbing the client bundle when fastDeploy is on", () => {
    const plugin = decoVitePlugin({ fastDeploy: true }) as {
      load: (id: string, options?: { ssr?: boolean }) => string | undefined;
    };
    expect(plugin.load(id, { ssr: false })).toBe(STUB);
  });

  it("does NOT stub blocks.gen on SSR by default (bundled fallback preserved)", () => {
    const plugin = decoVitePlugin() as {
      load: (id: string, options?: { ssr?: boolean }) => string | undefined;
    };
    // No .json sibling on disk for this synthetic path, so the hook falls
    // through to Vite (undefined) rather than returning a stub. The point is
    // that it never returns the empty stub for SSR.
    expect(plugin.load(id, { ssr: true })).not.toBe(STUB);
  });

  it("leaves unrelated modules alone with fastDeploy on", () => {
    const plugin = decoVitePlugin({ fastDeploy: true }) as {
      load: (id: string, options?: { ssr?: boolean }) => string | undefined;
    };
    expect(plugin.load("/repo/src/sections/Hero.tsx", { ssr: true })).toBeUndefined();
  });
});
