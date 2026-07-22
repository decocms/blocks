/**
 * Unit test for `buildCsvRedirectBlocks` — the generate-time materialization of
 * `website/loaders/redirectsFromCsv.ts` blocks into synthetic top-level redirect
 * blocks. Drives it against a tmp `public/` fixture and asserts the emitted
 * blocks are what `loadRedirects` (runtime) actually consumes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRedirects, matchRedirect } from "@decocms/blocks/sdk/redirects";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCsvRedirectBlocks } from "./csv-redirects";

describe("buildCsvRedirectBlocks", () => {
  let tmpDir: string;
  let blocksDir: string;
  let publicDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-redirects-"));
    blocksDir = path.join(tmpDir, ".deco", "blocks");
    publicDir = path.join(tmpDir, "public");
    fs.mkdirSync(blocksDir, { recursive: true });
    fs.mkdirSync(publicDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeCsv = (name: string, body: string) =>
    fs.writeFileSync(path.join(publicDir, name), body);

  it("materializes a CSV nested in site.routes into a top-level redirect block", () => {
    writeCsv("redirects.csv", "from,to,type\n/old,/new,permanent\n/tmp-old,/tmp-new,temporary\n");
    const blocks: Record<string, unknown> = {
      site: {
        __resolveType: "site/apps/site.ts",
        routes: [
          {
            __resolveType: "website/loaders/redirectsFromCsv.ts",
            from: "static/redirects.csv",
            redirects: [],
          },
        ],
      },
    };

    const csvBlocks = buildCsvRedirectBlocks(blocks, { blocksDir, silent: true });
    expect(Object.keys(csvBlocks)).toEqual(["__csv_redirects__redirects.csv"]);

    // The synthetic block is what loadRedirects consumes at runtime.
    const map = loadRedirects({ ...csvBlocks, ...blocks });
    expect(matchRedirect("/old", map)).toMatchObject({ to: "/new", status: 301 });
    expect(matchRedirect("/tmp-old", map)).toMatchObject({ to: "/tmp-new", status: 302 });
  });

  it("drops the header row instead of turning it into a redirect", () => {
    writeCsv("h.csv", "from,to,type\n/a,/b,permanent\n");
    const blocks = {
      x: { __resolveType: "website/loaders/redirectsFromCsv.ts", from: "public/h.csv" },
    };
    const map = loadRedirects(buildCsvRedirectBlocks(blocks, { blocksDir, silent: true }));
    expect(matchRedirect("/from", map)).toBeNull();
    expect(matchRedirect("/a", map)).toMatchObject({ to: "/b", status: 301 });
  });

  it("lets a curated redirect block win over a CSV row for the same `from`", () => {
    writeCsv("c.csv", "from,to,type\n/dup,/from-csv,permanent\n");
    const blocks: Record<string, unknown> = {
      "redirect-curated": {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/dup", to: "/from-cms", type: "permanent" },
      },
      site: {
        __resolveType: "site/apps/site.ts",
        routes: [{ __resolveType: "website/loaders/redirectsFromCsv.ts", from: "c.csv" }],
      },
    };
    const csvBlocks = buildCsvRedirectBlocks(blocks, { blocksDir, silent: true });
    // Merge CSV FIRST so curated wins (documented precedence).
    const map = loadRedirects({ ...csvBlocks, ...blocks });
    expect(matchRedirect("/dup", map)).toMatchObject({ to: "/from-cms" });
  });

  it("returns {} when no CSV loader is referenced", () => {
    const blocks = { a: { __resolveType: "website/loaders/redirect.ts" } };
    expect(buildCsvRedirectBlocks(blocks, { blocksDir, silent: true })).toEqual({});
  });

  it("does not throw when the referenced CSV is missing", () => {
    const blocks = {
      x: { __resolveType: "website/loaders/redirectsFromCsv.ts", from: "static/missing.csv" },
    };
    expect(() => buildCsvRedirectBlocks(blocks, { blocksDir, silent: true })).not.toThrow();
    expect(buildCsvRedirectBlocks(blocks, { blocksDir, silent: true })).toEqual({});
  });
});
