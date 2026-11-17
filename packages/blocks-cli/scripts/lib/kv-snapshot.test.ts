/**
 * `readKvDecofile` builds what the KV sync writes. A Fresh + deco repo
 * (`deno.json`, no `package.json`) must get keys Fresh's runtime would produce
 * (one decode pass) and keep a redirect block whose rules all moved to KV, since
 * Fresh resolves blocks by name. A TanStack repo keeps today's output.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFreshRepo, readKvDecofile } from "./kv-snapshot";

let repo: string;
let blocksDir: string;

const write = (file: string, content: unknown) =>
  fs.writeFileSync(path.join(blocksDir, file), JSON.stringify(content));

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "kv-decofile-"));
  blocksDir = path.join(repo, ".deco", "blocks");
  fs.mkdirSync(blocksDir, { recursive: true });
  // Double-encoded name: Fresh's parseBlockId decodes once → "Home%20Page".
  write("Home%2520Page.json", { __resolveType: "website/pages/Page.tsx", path: "/" });
  // Every rule exact → moves to KV.
  write("old-links.json", {
    __resolveType: "deco-sites/std/loaders/x/redirects.ts",
    redirects: [{ from: "/old", to: "/new", type: "permanent" }],
  });
  // Glob stays in the decofile.
  write("globs.json", {
    __resolveType: "website/loaders/redirects.ts",
    redirects: [{ from: "/blog/*", to: "/news", type: "temporary" }],
  });
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("readKvDecofile", () => {
  it("decodes keys once and keeps emptied redirect blocks on a Fresh repo", () => {
    fs.writeFileSync(path.join(repo, "deno.json"), "{}");
    const out = readKvDecofile(blocksDir, repo);

    expect(out.fresh).toBe(true);
    expect(Object.keys(out.blocks).sort()).toEqual(["Home%20Page", "globs", "old-links"]);
    expect(out.blocks["old-links"]).toEqual({
      __resolveType: "deco-sites/std/loaders/x/redirects.ts",
      redirects: [],
    });
    expect((out.blocks.globs as { redirects: unknown[] }).redirects).toHaveLength(1);
    expect(out.exact.map((r) => r.path)).toEqual(["/old"]);
  });

  it("keeps Fresh's singular blocks and /:param patterns in the decofile", () => {
    fs.writeFileSync(path.join(repo, "deno.json"), "{}");
    const singularGlob = {
      __resolveType: "website/loaders/redirect.ts",
      redirect: { from: "/blog/*", to: "/news", type: "temporary" },
    };
    const param = {
      __resolveType: "website/loaders/redirect.ts",
      redirect: { from: "/p/:id", to: "/produto/:id", type: "permanent" },
    };
    write("singular-glob.json", singularGlob);
    write("param.json", param);
    write("singular-exact.json", {
      __resolveType: "website/loaders/redirect.ts",
      redirect: { from: "/promo", to: "/sale", type: "temporary" },
    });
    const out = readKvDecofile(blocksDir, repo);

    expect(out.blocks["singular-glob"]).toEqual(singularGlob);
    expect(out.blocks.param).toEqual(param);
    expect(out.blocks["singular-exact"]).toEqual({ __resolveType: "website/loaders/redirect.ts", redirects: [] });
    expect(out.exact.map((r) => r.path).sort()).toEqual(["/old", "/promo"]);
  });

  it("keeps today's output on a TanStack repo", () => {
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    fs.writeFileSync(path.join(repo, "deno.json"), "{}");
    const out = readKvDecofile(blocksDir, repo);

    expect(out.fresh).toBe(false);
    expect(Object.keys(out.blocks).sort()).toEqual(["Home Page", "globs"]);
    expect(out.exact.map((r) => r.path)).toEqual(["/old"]);
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
