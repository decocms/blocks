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
// A v7 site's CSV redirects: a saved website/loaders/redirectsFromCsv.ts block
// (static/redirects.csv), one inline in the Site block's routes
// (/campaigns/black-friday.csv, forcePermanentRedirects) and a curated
// website/loaders/redirect.ts block; the CSV files under public/.
const CSV_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/v7-csv-redirects",
);

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function site(extra: Record<string, object> = {}, fixture: boolean | string = true): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-redirects-")));
  if (fixture) fs.cpSync(fixture === true ? FIXTURE : fixture, root, { recursive: true });
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

  it("answers permanent with a 301 and temporary (or no type) with v8's temporary 307", () => {
    site();
    foldRedirects(root, createReport());
    const { redirects } = read("Redirects.json");
    const status = (url: string) => {
      const match = matchRoute(url, { routes: [], redirects });
      return match.kind === "redirect" ? [match.location, match.status] : null;
    };
    expect(status("/a")).toEqual(["/b", 301]);
    expect(status("/old-shoes?utm=1")).toEqual(["/shoes", 301]);
    expect(status("/sale")).toEqual(["/black-friday", 307]);
    expect(status("/blog")).toEqual(["/news", 307]);
    expect(status("/c/shirts")).toEqual(["/category", 307]);
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

  it("folds what v7's loadRedirects read: 301 as permanent, trimmed routes, the std list type", () => {
    site(
      {
        "a-std.json": {
          __resolveType: "deco-sites/std/loaders/x/redirects.ts",
          redirects: [{ from: " /std ", to: " /std-new ", type: "301" }],
        },
        // v7 read `redirects ?? redirect` whatever the type: a per-rule block holding a list.
        "b-rule.json": {
          __resolveType: "website/loaders/redirect.ts",
          redirects: [{ from: "/one", to: "/two" }],
        },
      },
      false,
    );
    const report = createReport();
    foldRedirects(root, report);
    expect(read("Redirects.json")).toEqual({
      __resolveType: "redirects",
      redirects: [
        { from: "/std", to: "/std-new", permanent: true },
        { from: "/one", to: "/two", permanent: false },
      ],
    });
    expect(blockFiles()).toEqual(["Redirects.json"]);
    expect(report.manual).toEqual([]);
  });

  it("folds every CSV a v7 CSV loader reads, saved or inline, after the saved blocks", () => {
    site({}, CSV_FIXTURE);
    const report = createReport();
    foldRedirects(root, report);

    // The saved blocks first (the CSV loader's own rules too, as 7.x routed
    // them), then each CSV's rows in order, file by file.
    expect(read("Redirects.json")).toEqual({
      __resolveType: "redirects",
      redirects: [
        { from: "/from-the-loader", to: "/kept", permanent: true },
        { from: "/dup", to: "/from-cms", permanent: true },
        { from: "/old", to: "/new", permanent: true },
        { from: "/tmp-old", to: "/tmp-new", permanent: false },
        { from: "/numeric", to: "/n", permanent: true },
        { from: "/untyped", to: "/u", permanent: false },
        { from: "/keep-query", to: "/kq", permanent: false, discardQueryParameters: true },
        // type and discardQueryParameters are read by value, in any column.
        { from: "/x", to: "/y", permanent: true },
        // A semicolon splits too.
        { from: "/semi", to: "/semi-new", permanent: true },
        // An absolute source is its path and query, as 7.x matched it.
        { from: "/absolute?map=c", to: "/abs", permanent: true },
        // forcePermanentRedirects: a row with no type is permanent.
        { from: "/bf", to: "/black-friday", permanent: true },
        { from: "/bf-temp", to: "/black-friday", permanent: false },
      ],
    });
    // The loaders are gone, the saved one and the inline one; the CSV files stay.
    expect(blockFiles()).toEqual(["Redirects.json", "Site.json"]);
    expect(read("Site.json")).toEqual({
      __resolveType: "site/apps/site.ts",
      routes: [{ __resolveType: "website/loaders/pages.ts" }],
    });
    expect(fs.existsSync(path.join(root, "public/redirects.csv"))).toBe(true);
    expect(fs.existsSync(path.join(root, "public/campaigns/black-friday.csv"))).toBe(true);

    expect(report.done.map((n) => [n.subject, n.message])).toEqual([
      [
        ".deco/blocks/Site.json",
        'removed its v7 CSV redirects loader (website/loaders/redirectsFromCsv.ts: public/campaigns/black-friday.csv): the rows are in "Redirects"',
      ],
      [
        ".deco/blocks/Redirects.json",
        expect.stringMatching(
          /^folded 12 rules from the v7 redirect blocks Csv\.json, redirect-curated\.json and the CSV files public\/redirects\.csv, public\/campaigns\/black-friday\.csv, then deleted them: .*temporary permanent: false, a 307; under 7\.x's default \(legacy\) redirect semantics a temporary rule answered 302/,
        ),
      ],
    ]);
    // A curated rule wins over a CSV row for the same route, as in 7.x; within
    // the CSV the first row wins. A row with no to is left out.
    expect(report.manual.map((n) => [n.subject, n.message])).toEqual([
      [
        "public/redirects.csv",
        'its rule for /dup (to /from-csv, permanent) conflicts with the one from "redirect-curated" (to /from-cms), which was kept in "Redirects": change it there if this one should win',
      ],
      [
        "public/redirects.csv",
        'its rule for /tmp-old (to /elsewhere, temporary) conflicts with the one from "public/redirects.csv" (to /tmp-new), which was kept in "Redirects": change it there if this one should win',
      ],
      [
        "public/redirects.csv",
        'a row without a from and a to, left out of "Redirects", as 7.x skipped them',
      ],
      [
        "public/redirects.csv",
        expect.stringMatching(/^kept: v8 reads no CSV, and its 10 rows are/),
      ],
      [
        "public/campaigns/black-friday.csv",
        expect.stringMatching(/^kept: v8 reads no CSV, and its 2 rows are/),
      ],
    ]);

    // Temporary rows answer v8's temporary 307.
    const { redirects } = read("Redirects.json");
    const at = (url: string) => matchRoute(url, { routes: [], redirects });
    expect(at("/tmp-old")).toMatchObject({ location: "/tmp-new", status: 307 });
    expect(at("/old")).toMatchObject({ location: "/new", status: 301 });
    expect(at("/absolute?map=c")).toMatchObject({ location: "/abs?map=c", status: 301 });

    // A second run changes nothing.
    const before = fs.readFileSync(path.join(root, ".deco/blocks/Redirects.json"), "utf8");
    const again = createReport();
    foldRedirects(root, again);
    expect(fs.readFileSync(path.join(root, ".deco/blocks/Redirects.json"), "utf8")).toBe(before);
    expect(again).toEqual(createReport());
  });

  it("reads a CSV once however many loaders name it, and finds it under any 7.x prefix", () => {
    site(
      {
        "a.json": {
          __resolveType: "site/apps/site.ts",
          routes: [
            { __resolveType: "website/loaders/redirectsFromCsv.ts", from: "public/r.csv" },
            { __resolveType: "website/loaders/redirectsFromCsv.ts", from: "r.csv" },
          ],
        },
        "b.json": {
          __resolveType: "website/loaders/redirectsFromCsv.ts",
          from: "/static/r.csv",
          forcePermanentRedirects: true,
        },
      },
      false,
    );
    fs.mkdirSync(path.join(root, "public"));
    fs.writeFileSync(path.join(root, "public/r.csv"), "/a,/b\r\n/c,/d,temporary\r\n");
    const report = createReport();
    foldRedirects(root, report);
    // Any loader of the file setting forcePermanentRedirects makes its untyped rows permanent.
    expect(read("Redirects.json").redirects).toEqual([
      { from: "/a", to: "/b", permanent: true },
      { from: "/c", to: "/d", permanent: false },
    ]);
    expect(blockFiles()).toEqual(["Redirects.json", "a.json"]);
    expect(read("a.json")).toEqual({ __resolveType: "site/apps/site.ts", routes: [] });
    expect(report.done.map((n) => n.message)).toEqual([
      'removed its 2 v7 CSV redirects loaders (website/loaders/redirectsFromCsv.ts: public/r.csv): the rows are in "Redirects"',
      expect.stringContaining(
        "folded 2 rules from the v7 redirect blocks b.json and the CSV files public/r.csv",
      ),
    ]);
  });

  it("leaves and reports a CSV loader whose file 7.x couldn't read", () => {
    const loader = (from: string) => ({
      __resolveType: "website/loaders/redirectsFromCsv.ts",
      from,
    });
    const siteBlock = {
      __resolveType: "site/apps/site.ts",
      routes: [loader("https://cdn.example.com/redirects.csv"), loader("../../outside.csv")],
    };
    site({ "Missing.json": loader("static/missing.csv"), "Site.json": siteBlock }, false);
    const report = createReport();
    foldRedirects(root, report);
    // Nothing is folded or deleted: 7.x routed none of these rows.
    expect(blockFiles()).toEqual(["Missing.json", "Site.json"]);
    expect(read("Missing.json")).toEqual(loader("static/missing.csv"));
    expect(read("Site.json")).toEqual(siteBlock);
    expect(report.done).toEqual([]);
    expect(report.manual.map((n) => [n.subject, n.message])).toEqual([
      [
        ".deco/blocks/Missing.json",
        expect.stringContaining(
          "whose file wasn't read: public/missing.csv (from static/missing.csv) doesn't exist",
        ),
      ],
      [
        ".deco/blocks/Site.json",
        expect.stringContaining(
          "https://cdn.example.com/redirects.csv is a URL, which 7.x never fetched",
        ),
      ],
      [
        ".deco/blocks/Site.json",
        expect.stringMatching(/^holds .*: \.\.\/\.\.\/outside\.csv names .*, outside the site\./),
      ],
    ]);
  });

  it("reads a CSV outside public/ but in the site, as 7.x resolved it", () => {
    site(
      {
        "Csv.json": {
          __resolveType: "website/loaders/redirectsFromCsv.ts",
          from: "../data/redirects.csv",
        },
      },
      false,
    );
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data/redirects.csv"), "/a,/b,permanent\n");
    const report = createReport();
    foldRedirects(root, report);
    expect(blockFiles()).toEqual(["Redirects.json"]);
    expect(read("Redirects.json").redirects).toEqual([{ from: "/a", to: "/b", permanent: true }]);
    expect(report.manual.map((n) => [n.subject, n.message])).toEqual([
      ["data/redirects.csv", expect.stringMatching(/^kept: v8 reads no CSV/)],
    ]);
  });

  it("names the own redirects of a saved CSV loader whose file is missing: 7.x routed them", () => {
    site(
      {
        "Csv.json": {
          __resolveType: "website/loaders/redirectsFromCsv.ts",
          from: "static/missing.csv",
          redirects: [{ from: "/x", to: "/y", type: "permanent" }],
        },
      },
      false,
    );
    const report = createReport();
    foldRedirects(root, report);
    expect(blockFiles()).toEqual(["Csv.json"]);
    expect(report.manual.map((n) => n.message)).toEqual([
      expect.stringContaining(
        'is permanent: true), and the rule in its own "redirects", which 7.x routed, then remove the loader',
      ),
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
