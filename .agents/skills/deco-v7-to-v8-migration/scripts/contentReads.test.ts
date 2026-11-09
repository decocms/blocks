// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findContentReads, reportContentReads } from "./contentReads";
import { createReport } from "./report";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function site(files: Record<string, string>): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "content-reads-")));
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const SITEMAP = `import { cms } from "../cms";
export async function sitemap() {
  const c = cms.forRelease();
  const [pages] = await c.list("page");
  const [posts] = await cms.forRelease().list<{ path: string }>("post", { limit: 10 });
  const [seo] = await (await client()).list("seo");
  const [more] = await currentClient()!.list("page");
  const [x] = await cmsClient.list("x");
  return [pages, posts, seo, more, x];
}
`;

const NOT_CLIENTS = `export function f(items: { list(): string[] }, renderer: { list(b: string): string }) {
  const a = items.list();
  const b = renderer.list("<li>");
  const c = [1, 2].map(String);
  return [a, b, c];
}
`;

describe("findContentReads", () => {
  it("finds every list() on a CMS client, whatever made the client", () => {
    site({ "src/sitemap.ts": SITEMAP, "src/other.ts": NOT_CLIENTS });
    const reads = findContentReads(root);
    expect(reads.map((r) => [r.file, r.line, r.kind])).toEqual([
      ["src/sitemap.ts", 4, "list"],
      ["src/sitemap.ts", 5, "list"],
      ["src/sitemap.ts", 6, "list"],
      ["src/sitemap.ts", 7, "list"],
      ["src/sitemap.ts", 8, "list"],
    ]);
    expect(reads[0]?.code).toBe('c.list("page")');
  });

  it("finds scans of .deco/blocks (fs, globs, import.meta.glob), not the content module", () => {
    site({
      "scripts/build-sitemap.mjs": `import fs from "node:fs";
for (const f of fs.readdirSync(".deco/blocks")) console.log(f);
`,
      "src/blog.ts": `const posts = import.meta.glob("../.deco/blocks/collections%2Fblog*.json", { eager: true });
const more = glob.sync(path.join(root, ".deco/blocks", "*.json"));
import content from "../.deco/blocks.gen";
const one = await import("../.deco/blocks/Header.json");
export { posts, more, content, one };
`,
    });
    expect(findContentReads(root).map((r) => [r.file, r.line, r.kind])).toEqual([
      ["scripts/build-sitemap.mjs", 2, "scan"],
      ["src/blog.ts", 1, "scan"],
      ["src/blog.ts", 2, "scan"],
    ]);
  });

  it("skips node_modules and build output, and is empty for a site that reads the index", () => {
    site({
      "node_modules/x/index.ts": SITEMAP,
      ".next/server.js": SITEMAP,
      "src/sitemap.ts": `export async function sitemap(c: Client) {
  const [pages] = await c.entries("page");
  return pages?.filter((p) => !p.noIndex).map((p) => p.path);
}
`,
    });
    expect(findContentReads(root)).toEqual([]);
  });
});

describe("the report and the check", () => {
  it("each read is a line left to do, with the fix", () => {
    site({ "src/sitemap.ts": SITEMAP });
    const report = createReport();
    reportContentReads(root, report);
    expect(report.manual).toHaveLength(5);
    expect(report.manual[0]).toMatchObject({ step: "imports", subject: "src/sitemap.ts:4" });
    expect(report.manual[0]?.message).toContain("client.list() throws");
    for (const fix of [
      "client.routes()",
      "client.redirects()",
      "client.entries(type)",
      "client.resolve(name)",
    ]) {
      expect(report.manual[0]?.message).toContain(fix);
    }
  });

  it("checkContentReads fails on a list() call and passes once it reads entries()", () => {
    const run = () =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", path.join(HERE, "checkContentReads.ts"), "--root", root],
        {
          encoding: "utf8",
        },
      );
    site({ "src/sitemap.ts": SITEMAP });
    const failing = run();
    expect(failing.status, failing.stderr).toBe(1);
    expect(failing.stdout).toContain("src/sitemap.ts:4: error: client.list() throws");
    expect(failing.stdout).toContain("route with client.routes() and client.redirects()");
    fs.writeFileSync(path.join(root, "src/sitemap.ts"), "export const x = 1;\n");
    const passing = run();
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain("No content reads to change.");
  });
});
