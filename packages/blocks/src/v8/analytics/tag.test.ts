// @vitest-environment node
/**
 * The Deco Analytics tag's source (`runtime/`, `shared/`). It is not a package
 * module: decocms/analytics bundles each entry below into a standalone script
 * and its Worker serves them at `/_dq/a.js`, the way it does today for v7,
 * checkout and sites outside deco. These tests pin what that build relies on.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const v8 = dirname(here);
// Shell out to the esbuild binary: its JS API trips over Vitest's realm isolation.
const esbuildBin = join(here, "../../../../../node_modules/.bin/esbuild");
const out = mkdtempSync(join(tmpdir(), "dq-tag-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Every script the Worker composes a site's bundle from, as decocms/analytics builds them. */
const ENTRIES = [
  "runtime/src/index.ts",
  "runtime/modules/click.ts",
  "runtime/modules/commerce.ts",
  "runtime/modules/consent.ts",
  "runtime/modules/deco.ts",
  "runtime/modules/engagement.ts",
  "runtime/modules/errors.ts",
  "runtime/modules/heatmap.ts",
  "runtime/modules/vitals.ts",
  "runtime/view/view.ts",
];

function bundle(entry: string): { code: string; inputs: string[] } {
  const file = join(out, entry.replaceAll("/", "_"));
  execFileSync(
    esbuildBin,
    [
      join(here, entry),
      "--bundle",
      "--format=iife",
      "--minify",
      "--target=es2020",
      `--outfile=${file}.js`,
      `--metafile=${file}.json`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const inputs = Object.keys(JSON.parse(readFileSync(`${file}.json`, "utf-8")).inputs);
  return { code: readFileSync(`${file}.js`, "utf-8"), inputs };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__fixtures__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the Deco Analytics tag", () => {
  it.each(ENTRIES)("%s bundles into one self-contained strict-mode script", (entry) => {
    const { code } = bundle(entry);
    // The production bundles open with this directive. It comes from `strict` in this
    // folder's tsconfig.json, which ships with `src`, so the consumer's build emits it
    // without a tsconfig of its own. Losing it changes every bundle's bytes and runs the
    // tag in sloppy mode.
    expect(code.startsWith('"use strict";(()=>{')).toBe(true);
    expect(code).not.toMatch(/\bimport\s*[({"']|\brequire\(|node:/);
  });

  it.each(ENTRIES)("%s pulls in nothing from outside the tag's folder", (entry) => {
    // The tag runs on every page of every site; the CMS runtime and React must never
    // reach it through a stray import.
    const outside = bundle(entry)
      .inputs.map((input) => relative(here, join(process.cwd(), input)))
      .filter((input) => input.startsWith(".."));
    expect(outside).toEqual([]);
  });

  it("the CMS runtime imports nothing from the tag's source", () => {
    const tag = `${sep}analytics${sep}`;
    const offenders = sourceFiles(v8)
      .filter((file) => !file.includes(tag))
      .filter((file) =>
        /from\s+["'][^"']*analytics\/(runtime|shared)\//.test(readFileSync(file, "utf-8")),
      )
      .map((file) => relative(v8, file));
    expect(offenders).toEqual([]);
  });
});
