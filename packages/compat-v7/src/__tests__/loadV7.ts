/**
 * Test-only. Runs v7's own code from `src/__fixtures__/v7/` unchanged.
 *
 * Some reference files (cms/resolve.ts, tanstack/routes/cmsRoute.ts) import
 * half of v7: page loading, observability, the section registry. Those
 * imports don't take part in matching, so this loader evaluates the file as
 * it is (esbuild strips the types) and gives every import it doesn't have a
 * stub: `stubs` by fixture-relative path (or by package specifier, for
 * the few package imports), else an object whose every export
 * is a no-op function. `expose` names module-private functions to export, so
 * a test can call v7's `evaluateVariantRule` directly; the file's own text is
 * never edited.
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

/** A reference file's text. */
export function v7Source(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

/**
 * A loader over the fixtures with one module cache, so files loaded through
 * it share their imports (one cms/resolve.ts for builtins.ts and the test).
 * `source` evaluates text at a virtual path instead of the file there.
 */
export function v7Loader(options: { stubs?: Record<string, Exports> } = {}) {
  const cache = new Map<string, Exports>();

  const load = (rel: string, text?: string, expose?: string[]): Exports => {
    const hit = cache.get(rel);
    if (hit) return hit;
    const abs = join(root, rel);
    if (text === undefined && !existsSync(abs)) return noop;
    let src = text ?? readFileSync(abs, "utf8");
    if (expose?.length) src += `\nexport { ${expose.join(", ")} };\n`;
    const { code } = transformSync(src, {
      loader: rel.endsWith(".js") ? "js" : "ts",
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
      for (const ext of [".ts", ".js"]) {
        if (existsSync(join(root, target + ext))) return load(target + ext);
      }
      return noop;
    };
    new Function("require", "module", "exports", code)(require, module, module.exports);
    cache.set(rel, module.exports);
    return module.exports;
  };

  return (file: string, extra: { expose?: string[]; source?: string } = {}): Exports =>
    load(file, extra.source, extra.expose);
}
