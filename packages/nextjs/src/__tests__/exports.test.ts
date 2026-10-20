// @vitest-environment node
/**
 * The package's module graphs, as a Next.js build sees them:
 *
 * - Every subpath has the blocks shape (`types`, `source`, `default`), except
 *   `/config`, plain CommonJS that `next.config.js` requires as is.
 * - `/proxy` loads no React, no `@decocms/blocks/preview` and no
 *   `next/headers`: the proxy bundle stays small and never reaches a block map.
 * - `/image-loader` (the `loaderFile`, in every client bundle) is pure: no
 *   Node built-in, no CMS, no React.
 * - `/instrumentation` (bundled into `instrumentation.ts` for both runtimes)
 *   loads no React, no CMS and no Node built-in, and `@opentelemetry/api`
 *   only when `register()` runs.
 * - The request's draft lives in React's `cache()` (`server/slot.ts`), not in
 *   `AsyncLocalStorage`, so no subpath needs a per-runtime conditional export.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "../..");
const esbuildBin = join(packageDir, "../../node_modules/.bin/esbuild");

describe("exports", () => {
  it("each subpath: types, source, default; /config is CommonJS from src", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === "./config") {
        expect(target).toEqual({
          types: "./src/config/index.d.cts",
          default: "./src/config/index.cjs",
        });
        continue;
      }
      const t = target as Record<string, string>;
      expect(Object.keys(t), subpath).toEqual(["types", "source", "default"]);
      const base = t.source!.replace(/^\.\/src\//, "").replace(/\.tsx?$/, "");
      expect(t.types).toBe(`./dist/${base}.d.ts`);
      expect(t.default).toBe(`./dist/${base}.js`);
    }
  });

  it("next.config.js can require /config with plain Node", () => {
    const require = createRequire(join(packageDir, "package.json"));
    const config = require("@decocms/nextjs/config") as { withDeco: unknown };
    expect(typeof config.withDeco).toBe("function");
  });

  it("an ESM next.config imports /config by name", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { withDeco } from "@decocms/nextjs/config"; console.log(typeof withDeco)',
      ],
      { cwd: packageDir, encoding: "utf-8" },
    );
    expect(out.trim()).toBe("function");
  });
});

function bundle(entry: string, args: string[]): { output: string; inputs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "nextjs-bundle-"));
  try {
    const outfile = join(dir, "out.js");
    const metafile = join(dir, "meta.json");
    execFileSync(
      esbuildBin,
      [
        join(packageDir, "src", entry),
        "--bundle",
        "--format=esm",
        "--conditions=source",
        '--define:process.env.NODE_ENV="production"',
        `--outfile=${outfile}`,
        `--metafile=${metafile}`,
        "--log-level=error",
        ...args,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return {
      output: readFileSync(outfile, "utf-8"),
      inputs: Object.keys(JSON.parse(readFileSync(metafile, "utf-8")).inputs),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("module graphs", () => {
  it("/proxy: no React, no preview components, no next/headers", () => {
    const { inputs, output } = bundle("proxy/index.ts", [
      "--platform=neutral",
      "--main-fields=module,main",
      "--external:next",
      "--external:next/*",
    ]);
    expect(inputs.filter((i) => /node_modules\/(react|react-dom)\//.test(i))).toEqual([]);
    expect(inputs.some((i) => i.includes("/preview/"))).toBe(false);
    expect(inputs.some((i) => i.includes("server/"))).toBe(false);
    expect(output).not.toMatch(/next\/headers/);
    expect(output).toMatch(/next\/server/);
  });

  it("/image-loader: pure, safe in a browser bundle", () => {
    const { inputs, output } = bundle("image-loader/index.ts", ["--platform=browser"]);
    expect(output).not.toMatch(/["'`]node:|createCMS|AsyncLocalStorage/);
    expect(inputs.every((i) => i.includes("image-loader/") || i.endsWith("v8/image.ts"))).toBe(
      true,
    );
  });

  it("/instrumentation: no React, no CMS, no Node built-in; OpenTelemetry's API loaded at run time", () => {
    const { inputs, output } = bundle("instrumentation/index.ts", [
      "--platform=neutral",
      "--main-fields=module,main",
      "--external:@opentelemetry/api",
      "--external:next",
      "--external:next/*",
    ]);
    expect(inputs.filter((i) => /node_modules\/(react|react-dom)\//.test(i))).toEqual([]);
    expect(inputs.some((i) => /v8\/(cms|resolver|content)\.ts$/.test(i))).toBe(false);
    expect(output).not.toMatch(/["'`]node:|next\/server|next\/headers/);
    expect(output).toMatch(/import\(\s*"@opentelemetry\/api"\s*\)/);
  });

  it("the root components never load next/headers", () => {
    const { output } = bundle("index.ts", [
      "--platform=neutral",
      "--main-fields=module,main",
      "--external:react",
      "--external:react/*",
      "--external:next",
      "--external:next/*",
    ]);
    expect(output).not.toMatch(/next\/headers/);
    expect(output).not.toMatch(/AsyncLocalStorage/);
  });
});

describe("dependencies", () => {
  it("no @decocms/tanstack and no @decocms/apps-*: the site wires a platform's image helpers in itself", () => {
    const all = {
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
      ...(pkg as { dependencies?: Record<string, string> }).dependencies,
    };
    expect(
      Object.keys(all).filter(
        (name) => name === "@decocms/tanstack" || name.startsWith("@decocms/apps-"),
      ),
    ).toEqual([]);
  });

  it("no source file imports @decocms/tanstack or an @decocms/apps-* package", () => {
    const files = execFileSync("git", ["ls-files", "src"], { cwd: packageDir, encoding: "utf-8" })
      .split("\n")
      .filter((f) => /\.(c?ts|tsx|cjs)$/.test(f));
    const offenders = files.filter((f) =>
      /from\s+["']@decocms\/(tanstack|apps-[^"']*)["']|require\(["']@decocms\/(tanstack|apps-)/.test(
        readFileSync(join(packageDir, f), "utf-8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
