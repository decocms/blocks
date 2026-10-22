// @vitest-environment node
/**
 * v7's random matchers and date rules holding their own dates are reported,
 * never moved (./experiments.ts), on fixture sites.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_AN_AB_TEST, reportTestsAndDates, SCHEDULE_A_CAMPAIGN } from "./experiments";
import { createReport } from "./report";

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

const TANSTACK = { name: "site", dependencies: { "@decocms/tanstack": "^7.0.0" } };
const NEXTJS = { name: "site", dependencies: { "@decocms/nextjs": "^7.0.0" } };

function site(files: Record<string, string | object>): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-to-v8-")));
  for (const [file, data] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === "string" ? data : JSON.stringify(data));
  }
  return root;
}

/** Every file under `.deco/blocks`, as written. */
function snapshotBlocks(): Record<string, string> {
  const dir = path.join(root, ".deco", "blocks");
  return Object.fromEntries(
    fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
}

const page = (sections: unknown) => ({
  __resolveType: "website/pages/Page.tsx",
  name: "Home",
  path: "/",
  sections,
});
const hero = (title: string) => [{ __resolveType: "site/sections/Hero.tsx", title }];
const RANDOM = { __resolveType: "website/matchers/random.ts", traffic: 0.5 };
const WINDOW = { start: "2026-11-27T00:00:00-03:00", end: "2026-11-30T23:59:59-03:00" };

describe("random matchers", () => {
  it("one line pointing at Run an A/B test, naming the files; nothing changes", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Hero%20test.json": RANDOM,
      ".deco/blocks/Home.json": page({
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          { rule: { __resolveType: "Hero test" }, value: hero("New") },
          { rule: RANDOM, value: hero("Inline") },
        ],
      }),
    });
    const before = snapshotBlocks();
    const report = createReport();
    reportTestsAndDates(root, report);
    expect(snapshotBlocks()).toEqual(before);
    expect(report.done).toEqual([]);
    expect(report.manual).toHaveLength(1);
    const [line] = report.manual;
    expect(line?.subject).toBe("A/B tests");
    expect(line?.message).toContain(RUN_AN_AB_TEST);
    expect(line?.message).toContain("under its saved-block name");
    expect(line?.message).toContain('"Hero%20test.json", "Home.json"');
    expect(fs.existsSync(path.join(root, ".deco/blocks/experiments.json"))).toBe(false);
  });

  it("names the proxy on Next.js", () => {
    site({ "package.json": NEXTJS, ".deco/blocks/T.json": RANDOM });
    const report = createReport();
    reportTestsAndDates(root, report);
    expect(report.manual.find((n) => n.subject === "experiments")?.message).toContain("draftProxy");
  });

  it("names readVisitor and cms.client on a site with no binding", () => {
    site({ "package.json": { name: "site" }, ".deco/blocks/T.json": RANDOM });
    const report = createReport();
    reportTestsAndDates(root, report);
    const message = report.manual.find((n) => n.subject === "experiments")?.message;
    expect(message).toContain("readVisitor(request)");
    expect(message).toContain("cms.client({ visitor, ...(await cms.readVersion(request)) })");
  });
});

describe("date rules", () => {
  it("one line pointing at Schedule a campaign, for v7's and v8's inline dates; nothing changes", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Home.json": page({
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          { rule: { __resolveType: "date", ...WINDOW }, value: hero("Sale") },
          { rule: { __resolveType: "website/matchers/date.ts", ...WINDOW }, value: hero("v7") },
        ],
      }),
    });
    const before = snapshotBlocks();
    const report = createReport();
    reportTestsAndDates(root, report);
    expect(snapshotBlocks()).toEqual(before);
    expect(report.manual).toHaveLength(1);
    expect(report.manual[0]?.subject).toBe("date rules");
    expect(report.manual[0]?.message).toContain(SCHEDULE_A_CAMPAIGN);
    expect(fs.existsSync(path.join(root, ".deco/blocks/campaigns.json"))).toBe(false);
  });

  it("a campaign rule is left out; a prerelease date rule naming a campaign is reported", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Home.json": page({
        __resolveType: "website/flags/multivariate.ts",
        variants: [{ rule: { __resolveType: "campaign", name: "black-friday" }, value: [] }],
      }),
    });
    const report = createReport();
    reportTestsAndDates(root, report);
    expect(report).toEqual(createReport());

    site({
      "package.json": TANSTACK,
      ".deco/blocks/Home.json": page({
        __resolveType: "website/flags/multivariate.ts",
        variants: [{ rule: { __resolveType: "date", campaign: "black-friday" }, value: [] }],
      }),
    });
    const old = createReport();
    reportTestsAndDates(root, old);
    expect(old.manual.map((n) => n.subject)).toEqual(["date rules"]);
    expect(old.manual[0]?.message).toContain('{ "__resolveType": "campaign", "name": … }');
  });
});

it("a site with neither reports nothing", () => {
  site({ "package.json": NEXTJS, ".deco/blocks/Home.json": page(hero("Hi")) });
  const report = createReport();
  reportTestsAndDates(root, report);
  expect(report).toEqual(createReport());
});
