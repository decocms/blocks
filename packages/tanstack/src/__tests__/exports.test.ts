// @vitest-environment node
/**
 * The package's module graphs, checked with the resolvers that build sites:
 *
 * - `./scope` (the request scope behind `AsyncLocalStorage`) is a conditional
 *   export. Workers builds turn `browser` on too (`workerd, worker, browser`),
 *   so `workerd` and `node` must come before `browser`, or a production worker
 *   would get the no-op stub with no build error.
 * - The browser-safe entries (the root, `/react`, `/start`, `/router`) bundle for a
 *   browser with no Node built-in, no `AsyncLocalStorage` and no CMS.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "../..");
const esbuildBin = join(packageDir, "../../node_modules/.bin/esbuild");

/** Which scope implementation `@decocms/tanstack/scope` resolves to under Node's `--conditions`. */
function scopeUnder(conditions: string[]): string {
  return execFileSync(
    process.execPath,
    [
      ...["source", ...conditions].flatMap((c) => [`--conditions=${c}`]),
      "--input-type=module",
      "-e",
      'const m = await import("@decocms/tanstack/scope"); console.log(m.SCOPE_IMPLEMENTATION)',
    ],
    { cwd: packageDir, encoding: "utf-8" },
  ).trim();
}

describe("./scope: the conditional export", () => {
  it("lists workerd and node before browser", () => {
    const keys = Object.keys(pkg.exports["./scope"]);
    expect(keys.indexOf("workerd")).toBeLessThan(keys.indexOf("browser"));
    expect(keys.indexOf("node")).toBeLessThan(keys.indexOf("browser"));
  });

  it("a Workers build (workerd, worker, browser) gets AsyncLocalStorage", () => {
    expect(scopeUnder(["workerd", "worker", "browser"])).toBe("async-local-storage");
  });

  it("Node gets AsyncLocalStorage", () => {
    expect(scopeUnder([])).toBe("async-local-storage");
  });

  it("a browser build gets the stub", () => {
    // Node always has "node" on, so the browser case is checked with esbuild below too.
    const keys = Object.keys(pkg.exports["./scope"]);
    expect(
      (pkg.exports["./scope"] as Record<string, unknown>)[keys[keys.indexOf("browser")]!],
    ).toEqual({
      source: "./src/scope/browser.ts",
      default: "./dist/scope/browser.js",
    });
  });
});

function bundle(
  entry: string,
  args: string[],
  conditions: string[] = [],
): { output: string; inputs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "tanstack-bundle-"));
  try {
    const outfile = join(dir, "out.js");
    const metafile = join(dir, "meta.json");
    execFileSync(
      esbuildBin,
      [
        join(packageDir, "src", entry),
        "--bundle",
        "--format=esm",
        `--conditions=${["source", ...conditions].join(",")}`,
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

describe("browser bundles", () => {
  it.each([
    "index.ts",
    "react/index.ts",
    "start/index.ts",
    "router/index.ts",
  ])("%s has no Node built-in, no AsyncLocalStorage and no CMS", (entry) => {
    const { output, inputs } = bundle(entry, ["--platform=browser"]);
    expect(output).not.toMatch(/["'`]node:|AsyncLocalStorage|createCMS/);
    expect(inputs.some((i) => i.includes("scope/server.ts"))).toBe(false);
    expect(inputs.some((i) => i.includes("worker/"))).toBe(false);
  });

  it("/react takes the browser scope stub", () => {
    const { inputs } = bundle("react/index.ts", ["--platform=browser"]);
    expect(inputs.some((i) => i.endsWith("scope/browser.ts"))).toBe(true);
  });

  it("/worker, built for workerd (workerd, worker, browser), takes the real scope", () => {
    const { inputs, output } = bundle(
      "worker/index.ts",
      ["--platform=neutral", "--main-fields=module,main", "--external:node:*"],
      ["workerd", "worker", "browser"],
    );
    expect(inputs.some((i) => i.endsWith("scope/server.ts"))).toBe(true);
    expect(inputs.some((i) => i.endsWith("scope/browser.ts"))).toBe(false);
    expect(output).toContain("AsyncLocalStorage");
  });
});

describe("dependencies", () => {
  it("no @decocms/apps-* package: a site wires a platform's helpers (its image URLs) in itself", () => {
    const all = {
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
      ...(pkg as { dependencies?: Record<string, string> }).dependencies,
    };
    expect(Object.keys(all).filter((name) => name.startsWith("@decocms/apps-"))).toEqual([]);
  });
});
