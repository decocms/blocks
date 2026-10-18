// @vitest-environment node
/**
 * Guardrail for `@decocms/compat-v7`, the one home the product owner
 * approved (2026-10-14) for v7's pure helpers on v8 (CLAUDE.md, "No compat
 * layers"). It is not an upstream client and not a v7 runtime:
 *
 * - its framework-neutral subpaths (every export but `/tanstack` and
 *   `/nextjs`) use no network, no React, no "use client", read no
 *   environment, import nothing at run time but their own modules and
 *   `@decocms/blocks`, and bundle for a browser and for workerd;
 * - it exports none of v7's runtime (ctx, invoke, request scope, cached
 *   loaders);
 * - `@decocms/blocks` is its one required peer; a framework binding is only
 *   an optional peer, and `/nextjs` never reaches `@decocms/tanstack` (nor
 *   the reverse);
 * - nothing else in this repo depends on it: blocks, the bindings and the
 *   clients never import compat-v7.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/compat-v7");
const esbuildBin = join(root, "node_modules/.bin/esbuild");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const FRAMEWORK_SUBPATHS = ["./tanstack", "./nextjs"];

type Target = { source: string };
const subpaths = Object.entries(pkg.exports as Record<string, Target>);
const neutral = subpaths.filter(([subpath]) => !FRAMEWORK_SUBPATHS.includes(subpath));

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** The source files a module reaches through its relative imports. */
function graph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const [, spec] of code(entry).matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
    graph(join(dirname(entry), spec), seen);
  }
  return seen;
}

describe("@decocms/compat-v7", () => {
  it("is published under its name with the neutral subpaths of this release", () => {
    expect(pkg.name).toBe("@decocms/compat-v7");
    expect(pkg.private).toBeUndefined();
    expect(neutral.map(([s]) => s)).toEqual(
      expect.arrayContaining([
        ".",
        "./types",
        "./types/widgets",
        "./device",
        "./script",
        "./clx",
        "./matchers",
      ]),
    );
  });

  it("takes @decocms/blocks as its one required peer; a binding only as an optional peer", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies["@decocms/blocks"]).toBe("^8.3.0");
    for (const name of Object.keys(pkg.peerDependencies)) {
      if (name === "@decocms/blocks") continue;
      expect(["@decocms/tanstack", "@decocms/nextjs"]).toContain(name);
      expect(pkg.peerDependenciesMeta?.[name]?.optional, name).toBe(true);
    }
  });

  for (const [subpath, target] of neutral) {
    const name = `@decocms/compat-v7${subpath.slice(1)}`;
    it(`${name}: no network, React, client code, environment reads or foreign runtime imports`, () => {
      for (const file of graph(join(dir, target.source))) {
        expect(file.startsWith(join(dir, "src")), file).toBe(true);
        const text = code(file);
        const found = [
          /\bfetch\s*\(/,
          /createInstrumentedFetch/,
          /["']use client["']/,
          /from ["']react/,
          /process\.env|import\.meta\.env|Deno\.env/,
          /^import (?!type )[^"']*["'](?!\.|@decocms\/blocks)/m,
          /^export [^"']*from ["'](?!\.|@decocms\/blocks)/m,
          /@decocms\/(tanstack|nextjs)/,
        ].filter((pattern) => pattern.test(text));
        expect([file, found]).toEqual([file, []]);
      }
    });

    it(`${name}: bundles for a browser and a workerd target with no Node built-ins and no React`, () => {
      for (const args of [
        ["--platform=browser"],
        ["--platform=neutral", "--conditions=workerd,worker,browser"],
      ]) {
        const output = execFileSync(
          esbuildBin,
          [
            join(dir, target.source),
            "--bundle",
            "--format=esm",
            "--external:@decocms/blocks",
            ...args,
          ],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
        expect(output).not.toMatch(/node:|require\(|react/);
      }
    });
  }

  it("exports none of v7's runtime", async () => {
    const DENIED =
      /^(invoke|createInvokeFn|ctx|AppContext|FnContext|RequestContext|getRequestContext|cachedLoader|createCachedLoader|useSection|usePartialSection|setupApps|createDecoWorkerEntry)$/;
    for (const [subpath, target] of neutral) {
      const mod = await import(join(dir, target.source));
      expect([subpath, Object.keys(mod).filter((k) => DENIED.test(k))]).toEqual([subpath, []]);
    }
  });

  it("/nextjs never imports @decocms/tanstack, and /tanstack never imports @decocms/nextjs", () => {
    for (const [subpath, other] of [
      ["./nextjs", "@decocms/tanstack"],
      ["./tanstack", "@decocms/nextjs"],
    ]) {
      const target = (pkg.exports as Record<string, Target | undefined>)[subpath];
      if (!target) continue;
      for (const file of graph(join(dir, target.source))) {
        expect([file, code(file).includes(other)]).toEqual([file, false]);
      }
    }
  });

  it("no other package depends on it or imports it", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(join(root, "packages"))) {
      if (name === "compat-v7") continue;
      const base = join(root, "packages", name);
      if (!existsSync(join(base, "package.json"))) continue;
      const m = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
      for (const field of [
        "dependencies",
        "peerDependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        if (m[field]?.["@decocms/compat-v7"]) offenders.push(`${name}: ${field}`);
      }
      for (const file of readdirSync(join(base, "src"), { recursive: true, encoding: "utf8" })) {
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file) || /\.test\.tsx?$|__tests__/.test(file)) continue;
        const text = readFileSync(join(base, "src", file), "utf8");
        if (/(from|import\(|require\()\s*["']@decocms\/compat-v7/.test(text)) {
          offenders.push(`${name}: src/${file}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
