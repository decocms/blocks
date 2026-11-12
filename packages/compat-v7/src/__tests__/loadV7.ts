/**
 * Test-only. Runs v7's own code from `src/__fixtures__/v7/` unchanged.
 *
 * Some reference files (cms/resolve.ts, cms/sectionLoaders.ts) import
 * half of v7: page loading, observability, the section registry. Those
 * imports don't take part in matching, so this loader evaluates the file as
 * it is (esbuild strips the types) and gives every import it doesn't have a
 * stub: `stubs` by fixture-relative path (or by package specifier, for
 * the few package imports), else an object whose every export
 * is a no-op function. The file's own text is never edited.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/v7");

type Exports = Record<string, any>;

export const noop: Exports = new Proxy(
  {},
  {
    get: (_, key) => (key === "__esModule" ? true : () => undefined),
  },
);

/**
 * A loader over the fixtures with one module cache, so files loaded through
 * it share their imports (one cms/resolve.ts for builtins.ts and the test).
 */
export function v7Loader(options: { stubs?: Record<string, Exports> } = {}) {
  const cache = new Map<string, Exports>();

  const load = (rel: string): Exports => {
    const hit = cache.get(rel);
    if (hit) return hit;
    const abs = join(root, rel);
    if (!existsSync(abs)) return noop;
    const { code } = transformSync(readFileSync(abs, "utf8"), {
      loader: rel.endsWith(".js") ? "js" : rel.endsWith(".tsx") ? "tsx" : "ts",
      format: "cjs",
      target: "es2022",
    });
    const module = { exports: {} as Exports };
    cache.set(rel, module.exports);
    const require = (spec: string): Exports => {
      if (!spec.startsWith(".")) {
        const bare = options.stubs?.[spec];
        if (bare) return bare;
        throw new Error(`v7 fixture ${rel} imports ${spec}`);
      }
      const target = relative(root, join(root, dirname(rel), spec));
      const stub = options.stubs?.[target];
      if (stub) return stub;
      for (const ext of [".ts", ".tsx", ".js"]) {
        if (existsSync(join(root, target + ext))) return load(target + ext);
      }
      return noop;
    };
    new Function("require", "module", "exports", code)(require, module, module.exports);
    cache.set(rel, module.exports);
    return module.exports;
  };

  return (file: string): Exports => load(file);
}
