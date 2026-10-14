// @vitest-environment node
/**
 * Guardrail: besides its client (the package root, checked by
 * upstream-clients.guardrail.test.ts), a `packages/apps-*` package may ship
 * pure helper subpaths: platform knowledge a site composes with
 * `@decocms/blocks`, such as `@decocms/apps-vtex/image` (VTEX's image URLs as
 * `ImageProvider`s for `createImageUrl`). The product owner asked for this
 * (review of 2026-10-14): `@decocms/blocks` keeps only framework code, and a
 * commerce platform's helpers move to its client package as pure functions.
 *
 * Pure means: no network (no fetch, not even the instrumented one), no React,
 * no "use client", no environment reads, no module state a request could
 * change, and nothing imported at runtime but its own modules (types from
 * `@decocms/blocks` are fine). A real esbuild bundle proves the last part and
 * that it runs in a browser and on workerd.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const esbuildBin = join(root, "node_modules/.bin/esbuild");

/** Every helper subpath: the exports of each apps-* package other than its root. */
const HELPERS = readdirSync(join(root, "packages"))
  .filter((dir) => dir.startsWith("apps-"))
  .flatMap((dir) => {
    const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
    return Object.entries(pkg.exports as Record<string, { source: string }>)
      .filter(([subpath]) => subpath !== ".")
      .map(([subpath, target]) => ({
        name: `${pkg.name}${subpath.slice(1)}`,
        dir,
        file: join(root, "packages", dir, target.source),
      }));
  });

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("apps-* helper subpaths are pure", () => {
  it("the image helpers are listed", () => {
    expect(HELPERS.map((h) => h.name).sort()).toEqual(
      expect.arrayContaining(["@decocms/apps-shopify/image", "@decocms/apps-vtex/image"]),
    );
  });

  for (const { name, file } of HELPERS) {
    it(`${name}: no network, React, client code, environment reads or runtime imports`, () => {
      expect(existsSync(file)).toBe(true);
      const text = code(file);
      const found = [
        /\bfetch\s*\(/,
        /createInstrumentedFetch/,
        /["']use client["']/,
        /from ["']react/,
        /process\.env|import\.meta\.env|Deno\.env/,
        /^\s*(let|var)\s/m,
        /^import (?!type )/m,
      ].filter((pattern) => pattern.test(text));
      expect(found).toEqual([]);
    });

    it(`${name}: bundles for a browser and a workerd target with no Node built-ins and no React`, () => {
      for (const args of [
        ["--platform=browser"],
        ["--platform=neutral", "--conditions=workerd,worker,browser"],
      ]) {
        const output = execFileSync(esbuildBin, [file, "--bundle", "--format=esm", ...args], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(output).not.toMatch(/node:|require\(|react/);
      }
    });
  }
});
