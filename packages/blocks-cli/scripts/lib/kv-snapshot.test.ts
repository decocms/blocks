/**
 * `readKvDecofile` builds what the KV sync writes. A Fresh + deco repo
 * (`deno.json`, no `package.json`) must get keys Fresh's runtime would produce
 * (one decode pass), and only the redirects Fresh applies by type move to KV.
 * A TanStack repo keeps today's output.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFreshRepo, readKvDecofile } from "./kv-snapshot";

let repo: string;
let blocksDir: string;

const write = (file: string, content: unknown) => fs.writeFileSync(path.join(blocksDir, file), JSON.stringify(content));
const single = (from: string) => ({
  __resolveType: "website/loaders/redirect.ts",
  redirect: { from, to: "/to", type: "permanent" },
});
const std = {
  __resolveType: "deco-sites/std/loaders/x/redirects.ts",
  redirects: [{ from: "/old", to: "/new", type: "permanent" }],
};
const site = {
  __resolveType: "website/mod.ts",
  routes: [{ __resolveType: "website/loaders/pages.ts" }, { __resolveType: "website/loaders/redirects.ts" }],
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "kv-decofile-"));
  blocksDir = path.join(repo, ".deco", "blocks");
  fs.mkdirSync(blocksDir, { recursive: true });
  // Double-encoded name: Fresh's parseBlockId decodes once → "Home%20Page".
  write("Home%2520Page.json", { __resolveType: "website/pages/Page.tsx", path: "/" });
  write("std-redirects.json", std);
  write("promo.json", single("/promo"));
  write("blog.json", single("/blog/*"));
  write("param.json", single("/p/:id"));
  write("absolute.json", single("https://site.com/abs"));
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("readKvDecofile on a Fresh repo", () => {
  beforeEach(() => fs.writeFileSync(path.join(repo, "deno.json"), "{}"));

  it("moves only exact website/loaders/redirect.ts rules, when the collector is routed", () => {
    write("Site.json", site);
    const out = readKvDecofile(blocksDir, repo);

    expect(out.fresh).toBe(true);
    expect(out.exact.map((r) => r.path)).toEqual(["/promo"]);
    // Moved: emptied, still resolvable by name.
    expect(out.blocks.promo).toEqual({ __resolveType: "website/loaders/redirect.ts" });
    // Kept verbatim (singular shape): glob, URLPattern, absolute URL.
    expect(out.blocks.blog).toEqual(single("/blog/*"));
    expect(out.blocks.param).toEqual(single("/p/:id"));
    expect(out.blocks.absolute).toEqual(single("https://site.com/abs"));
    // Fresh applies a std block only if referenced: never moved.
    expect(out.blocks["std-redirects"]).toEqual(std);
    // One decode pass.
    expect(out.blocks["Home%20Page"]).toBeDefined();
  });

  it("moves nothing when no route collects the redirect blocks", () => {
    const out = readKvDecofile(blocksDir, repo);
    expect(out.exact).toEqual([]);
    expect(out.blocks.promo).toEqual(single("/promo"));
  });
});

describe("readKvDecofile on a TanStack repo", () => {
  it("keeps today's output", () => {
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    fs.writeFileSync(path.join(repo, "deno.json"), "{}");
    const out = readKvDecofile(blocksDir, repo);

    expect(out.fresh).toBe(false);
    expect(Object.keys(out.blocks)).toContain("Home Page");
    expect(out.blocks["std-redirects"]).toBeUndefined();
    expect(out.exact.map((r) => r.path).sort()).toEqual(["/abs", "/old", "/p/:id", "/promo"]);
  });
});

describe("isFreshRepo", () => {
  it("needs deno.json(c) and no package.json", () => {
    expect(isFreshRepo(repo)).toBe(false);
    fs.writeFileSync(path.join(repo, "deno.jsonc"), "{}");
    expect(isFreshRepo(repo)).toBe(true);
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    expect(isFreshRepo(repo)).toBe(false);
  });
});
