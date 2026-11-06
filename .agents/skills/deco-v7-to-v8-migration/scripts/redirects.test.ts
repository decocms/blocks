// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchRoute } from "@decocms/blocks";
import { afterEach, describe, expect, it } from "vitest";
import { foldRedirects } from "./redirects";
import { createReport } from "./report";

// A v7 site's redirects: three per-rule website/loaders/redirect.ts blocks, a
// website/loaders/redirects.ts list named Redirects, and one inline in the Site block.
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/v7-redirects",
);

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function site(extra: Record<string, object> = {}, fixture = true): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-redirects-")));
  if (fixture) fs.cpSync(FIXTURE, root, { recursive: true });
  for (const [file, data] of Object.entries(extra)) {
    const full = path.join(root, ".deco/blocks", file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`);
  }
  return root;
}

const read = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks", file), "utf8"));
const blockFiles = () => fs.readdirSync(path.join(root, ".deco/blocks")).sort();

describe("redirects", () => {
  it("folds every v7 redirect block into one Redirects block of type redirects", () => {
    site();
    const site7 = read("Site.json");
    const report = createReport();
    foldRedirects(root, report);

    // Redirects (the v7 list) first, then the per-rule blocks, in code-unit name order.
    expect(read("Redirects.json")).toEqual({
      __resolveType: "redirects",
      redirects: [
        { from: "/a", to: "/b", permanent: true },
        { from: "/sale", to: "/black-friday", permanent: false },
        { from: "/old-shoes", to: "/shoes", permanent: true, discardQueryParameters: true },
        { from: "/c/*", to: "/category", permanent: false, discardQueryParameters: false },
        { from: "/blog", to: "/news", permanent: false },
      ],
    });
    // The per-rule blocks are gone; what isn't a redirect block is untouched.
    expect(blockFiles()).toEqual(["Redirects.json", "Site.json", "pages-home.json"]);
    expect(read("Site.json")).toEqual(site7);

    expect(report.done).toEqual([
      expect.objectContaining({
        step: "content",
        subject: ".deco/blocks/Redirects.json",
        message: expect.stringMatching(
          /^folded 5 rules from the v7 redirect blocks Redirects\.json, redirect-a1b2\.json, redirect-c3d4\.json, redirect-e5f6\.json/,
        ),
      }),
    ]);
    // The first rule for a route wins; an identical later one is dropped quietly,
    // a different one reported. Rules with no from are reported, and inline ones.
    expect(report.manual.map((n) => [n.subject, n.message])).toEqual([
      [
        ".deco/blocks/Site.json",
        expect.stringMatching(/^holds a v7 redirect inline .*which v8 doesn't route/),
      ],
      [".deco/blocks/Redirects.json", expect.stringMatching(/^a rule without a from and a to/)],
      [
        ".deco/blocks/redirect-c3d4.json",
        'its rule for /sale (to /promo, temporary) conflicts with the one from "Redirects" (to /black-friday), which was kept in "Redirects": change it there if this one should win',
      ],
    ]);
  });

  it("keeps v7's statuses: permanent a 301, temporary (or no type) a 302, as v7 answered", () => {
    site();
    foldRedirects(root, createReport());
    const { redirects } = read("Redirects.json");
    const status = (url: string) => {
      const match = matchRoute(url, { routes: [], redirects });
      return match.kind === "redirect" ? [match.location, match.status] : null;
    };
    expect(status("/a")).toEqual(["/b", 301]);
    expect(status("/old-shoes?utm=1")).toEqual(["/shoes", 301]);
    expect(status("/sale")).toEqual(["/black-friday", 302]);
    expect(status("/blog")).toEqual(["/news", 302]);
    expect(status("/c/shirts")).toEqual(["/category", 302]);
  });

  it("changes nothing on a second run", () => {
    site();
    foldRedirects(root, createReport());
    const before = fs.readFileSync(path.join(root, ".deco/blocks/Redirects.json"), "utf8");
    const report = createReport();
    foldRedirects(root, report);
    expect(fs.readFileSync(path.join(root, ".deco/blocks/Redirects.json"), "utf8")).toBe(before);
    expect(report.done).toEqual([]);
  });

  it("adds to an existing redirects block: its rules come first and win", () => {
    const existing = {
      __resolveType: "redirects",
      redirects: [{ from: "/blog", to: "/journal", permanent: true, status: 308 }],
    };
    site(
      {
        "Redirects.json": existing,
        "redirect-x.json": {
          __resolveType: "website/loaders/redirect.ts",
          redirect: { from: "/blog", to: "/news", type: "temporary" },
        },
        "list.json": {
          __resolveType: "website/loaders/redirects.ts",
          redirects: [{ from: "/x", to: "/y", type: "permanent" }],
        },
      },
      false,
    );
    const report = createReport();
    foldRedirects(root, report);
    expect(read("Redirects.json")).toEqual({
      __resolveType: "redirects",
      redirects: [...existing.redirects, { from: "/x", to: "/y", permanent: true }],
    });
    expect(blockFiles()).toEqual(["Redirects.json"]);
    expect(report.manual.map((n) => n.subject)).toEqual([".deco/blocks/redirect-x.json"]);
  });

  it("leaves everything when Redirects is some other block, and says to rename it", () => {
    const other = { __resolveType: "site/loaders/redirects.ts", list: [] };
    const v7 = {
      __resolveType: "website/loaders/redirect.ts",
      redirect: { from: "/a", to: "/b", type: "permanent" },
    };
    site({ "Redirects.json": other, "redirect-1.json": v7 }, false);
    const report = createReport();
    foldRedirects(root, report);
    expect(read("Redirects.json")).toEqual(other);
    expect(read("redirect-1.json")).toEqual(v7);
    expect(report.done).toEqual([]);
    expect(report.manual).toEqual([
      expect.objectContaining({
        subject: ".deco/blocks/Redirects.json",
        message: expect.stringContaining("rename this"),
      }),
    ]);
  });

  it("does nothing on a site with no v7 redirect block", () => {
    site({ "Home.json": { __resolveType: "website/pages/Page.tsx", path: "/" } }, false);
    const report = createReport();
    foldRedirects(root, report);
    expect(blockFiles()).toEqual(["Home.json"]);
    expect(report).toEqual(createReport());
  });
});
