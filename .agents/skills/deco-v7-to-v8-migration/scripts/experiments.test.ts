// @vitest-environment node
/**
 * v7's random matchers → the built-in `Experiments` block and `experiment`
 * rules (./experiments.ts), on fixture sites.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INLINE_EXPERIMENT, migrateRandomMatchers, trafficPercent } from "./experiments";
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

const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const exists = (file: string) => fs.existsSync(path.join(root, file));
const page = (sections: unknown) => ({
  __resolveType: "website/pages/Page.tsx",
  name: "Home",
  path: "/",
  sections,
});
const hero = (title: string) => [{ __resolveType: "site/sections/Hero.tsx", title }];

describe("trafficPercent", () => {
  it("is v7's traffic share as a whole percentage, 50 when unset", () => {
    expect(trafficPercent(0.5)).toBe(50);
    expect(trafficPercent(0.333)).toBe(33);
    expect(trafficPercent(0.005)).toBe(1);
    expect(trafficPercent(1)).toBe(100);
    expect(trafficPercent(0)).toBe(0);
    expect(trafficPercent(undefined)).toBe(50);
    expect(trafficPercent("0.2")).toBe(50);
    expect(trafficPercent(2)).toBe(100);
    expect(trafficPercent(-1)).toBe(0);
  });
});

describe("saved random matchers", () => {
  it("become Experiments entries and experiment rules; the saved matchers are deleted", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Test%20AB%200%2C5.json": {
        __resolveType: "website/matchers/random.ts",
        traffic: 0.5,
      },
      ".deco/blocks/Banner%20test.json": { __resolveType: "website/matchers/random", traffic: 0.1 },
      ".deco/blocks/Home.json": page([
        {
          __resolveType: "website/flags/multivariate.ts",
          variants: [
            { rule: { __resolveType: "Test AB 0,5" }, value: hero("B") },
            { rule: { __resolveType: "website/matchers/always.ts" }, value: hero("A") },
          ],
        },
        {
          __resolveType: "multivariate",
          experiment: "kept",
          variants: [{ rule: { __resolveType: "Banner test" }, value: hero("New") }],
        },
        {
          __resolveType: "website/flags/multivariate.ts",
          variants: [{ rule: { __resolveType: "website/matchers/always.ts" }, value: hero("A") }],
        },
      ]),
      // A rule nested in v7's multi matcher.
      ".deco/blocks/Footer.json": {
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              op: "and",
              matchers: [
                { __resolveType: "Banner test" },
                { __resolveType: "website/matchers/device.ts", mobile: true },
              ],
            },
            value: hero("Mobile B"),
          },
        ],
      },
    });
    const report = createReport();
    migrateRandomMatchers(root, report);

    expect(read(".deco/blocks/Experiments.json")).toEqual({
      __resolveType: "experiments",
      "Banner test": 10,
      "Test AB 0,5": 50,
    });
    expect(exists(".deco/blocks/Test%20AB%200%2C5.json")).toBe(false);
    expect(exists(".deco/blocks/Banner%20test.json")).toBe(false);

    const sections = read(".deco/blocks/Home.json").sections;
    expect(sections[0].experiment).toBe("Test AB 0,5");
    expect(sections[0].variants[0].rule).toEqual({
      __resolveType: "experiment",
      name: "Test AB 0,5",
    });
    expect(sections[0].variants[1].rule).toEqual({ __resolveType: "website/matchers/always.ts" });
    // An experiment ID already set is kept.
    expect(sections[1].experiment).toBe("kept");
    expect(sections[1].variants[0].rule).toEqual({
      __resolveType: "experiment",
      name: "Banner test",
    });
    expect(sections[2].experiment).toBeUndefined();

    const footer = read(".deco/blocks/Footer.json");
    expect(footer.variants[0].rule.matchers[0]).toEqual({
      __resolveType: "experiment",
      name: "Banner test",
    });
    expect(footer.variants[0].rule.matchers[1].__resolveType).toBe("website/matchers/device.ts");

    expect(report.done.map((n) => n.subject)).toEqual(
      expect.arrayContaining([
        "Home.json",
        "Footer.json",
        "Test%20AB%200%2C5.json",
        "Banner%20test.json",
        "Experiments.json",
      ]),
    );
    // TanStack's worker assigns the visitors: nothing left to do.
    expect(report.manual).toEqual([]);
  });

  it("adds to an Experiments block that exists, keeping its tests", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Experiments.json": { __resolveType: "experiments", "New header": 20 },
      ".deco/blocks/Hero%20test.json": { __resolveType: "website/matchers/random.ts" },
    });
    migrateRandomMatchers(root, createReport());
    expect(read(".deco/blocks/Experiments.json")).toEqual({
      __resolveType: "experiments",
      "New header": 20,
      "Hero test": 50,
    });
  });

  it("leaves everything when another block is saved as Experiments, and says why", () => {
    const files = {
      "package.json": TANSTACK,
      ".deco/blocks/Experiments.json": { __resolveType: "site/sections/Hero.tsx" },
      ".deco/blocks/Hero%20test.json": { __resolveType: "website/matchers/random.ts" },
      ".deco/blocks/Home.json": page({
        __resolveType: "website/flags/multivariate.ts",
        variants: [{ rule: { __resolveType: "Hero test" }, value: hero("B") }],
      }),
    };
    site(files);
    const report = createReport();
    migrateRandomMatchers(root, report);
    expect(read(".deco/blocks/Experiments.json")).toEqual(files[".deco/blocks/Experiments.json"]);
    expect(exists(".deco/blocks/Hero%20test.json")).toBe(true);
    expect(read(".deco/blocks/Home.json")).toEqual(files[".deco/blocks/Home.json"]);
    expect(report.done).toEqual([]);
    expect(report.manual[0].message).toContain("rename this block");
  });
});

describe("inline random rules", () => {
  const rule = (traffic?: number) => ({
    __resolveType: "website/matchers/random.ts",
    ...(traffic === undefined ? {} : { traffic }),
  });
  const flag = (r: object) => ({
    __resolveType: "website/flags/multivariate.ts",
    variants: [{ rule: r, value: hero("B") }],
  });

  it("with one traffic share become one experiment under v7's shared name", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Home.json": page([flag(rule(0.5)), flag(rule())]),
    });
    const report = createReport();
    migrateRandomMatchers(root, report);
    expect(read(".deco/blocks/Experiments.json")).toEqual({
      __resolveType: "experiments",
      [INLINE_EXPERIMENT]: 50,
    });
    const sections = read(".deco/blocks/Home.json").sections;
    for (const s of sections) {
      expect(s.variants[0].rule).toEqual({ __resolveType: "experiment", name: INLINE_EXPERIMENT });
      // v7 kept no results under an inline rule: no experiment ID is made up.
      expect(s.experiment).toBeUndefined();
    }
    expect(report.manual).toEqual([]);
  });

  it("with different traffic shares become one experiment per share, reported", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Random%2020%25.json": {
        __resolveType: "website/matchers/random.ts",
        traffic: 0.2,
      },
      ".deco/blocks/Home.json": page([flag(rule(0.2)), flag(rule(0.5)), flag(rule(0.2))]),
    });
    const report = createReport();
    migrateRandomMatchers(root, report);
    expect(read(".deco/blocks/Experiments.json")).toEqual({
      __resolveType: "experiments",
      "Random 20%": 20,
      "Random 20% (2)": 20,
      "Random 50%": 50,
    });
    const names = read(".deco/blocks/Home.json").sections.map(
      (s: { variants: { rule: { name: string } }[] }) => s.variants[0].rule.name,
    );
    expect(names).toEqual(["Random 20% (2)", "Random 50%", "Random 20% (2)"]);
    const notice = report.manual.find((n) => n.subject === "Experiments")?.message;
    expect(notice).toContain("different traffic shares");
    expect(notice).toContain('"Random 20% (2)", "Random 50%"');
  });
});

describe("what's left to wire", () => {
  const files = {
    ".deco/blocks/Hero%20test.json": { __resolveType: "website/matchers/random.ts" },
  };

  it("names the proxy on Next.js", () => {
    site({ "package.json": NEXTJS, ...files });
    const report = createReport();
    migrateRandomMatchers(root, report);
    expect(report.manual.find((n) => n.subject === "Experiments")?.message).toContain("draftProxy");
  });

  it("names assign and forRelease on a site with no binding", () => {
    site({ "package.json": { name: "site" }, ...files });
    const report = createReport();
    migrateRandomMatchers(root, report);
    const message = report.manual.find((n) => n.subject === "Experiments")?.message;
    expect(message).toContain("readSegment(request)");
    expect(message).toContain("cms.forRelease({ assignments })");
  });

  it("does nothing on a site with no random matcher; date rules stay inline", () => {
    const date = {
      __resolveType: "date",
      start: "2026-11-27T00:00:00-03:00",
      end: "2026-11-30T23:59:59-03:00",
    };
    site({
      "package.json": NEXTJS,
      ".deco/blocks/Home.json": page({
        __resolveType: "website/flags/multivariate.ts",
        variants: [{ rule: date, value: hero("Sale") }],
      }),
    });
    const report = createReport();
    migrateRandomMatchers(root, report);
    expect(report).toEqual(createReport());
    expect(exists(".deco/blocks/Experiments.json")).toBe(false);
    expect(exists(".deco/blocks/Schedules.json")).toBe(false);
    expect(read(".deco/blocks/Home.json").sections.variants[0].rule).toEqual(date);
  });
});
