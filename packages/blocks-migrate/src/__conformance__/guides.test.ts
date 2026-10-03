// @vitest-environment node
/**
 * Conformance: renames-and-migrations claims about the migration tool
 * (mig-07, mig-11, mig-12). Vendoring, secrets and experiment IDs are covered
 * end to end by ../migrate.test.ts and ../steps.test.ts; this file adds the
 * tag-manager row of "Telemetry and analytics".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBlockMap } from "../blockMap";
import { copyExperimentIds } from "../experiments";
import { createReport, formatReport } from "../report";

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function site(files: Record<string, string | object>): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-conf-")));
  for (const [file, data] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === "string" ? data : JSON.stringify(data));
  }
  return root;
}

describe("telemetry and analytics", () => {
  it("mig-11: the v7 Analytics section's GTM/GA4 tag IDs reach the person who moves them", () => {
    // The tag manager block belongs to the site's platform template, which
    // the migration can't know; what it can do is carry the IDs over in the
    // report, so nothing is lost when the v7 section goes.
    const dir = site({
      "package.json": { name: "site", type: "module" },
      ".deco/blocks/Analytics.json": {
        __resolveType: "website/sections/Analytics/Analytics.tsx",
        trackingIds: ["GTM-ABC123"],
        googleAnalyticsIds: ["G-XYZ789"],
      },
    });
    const report = createReport();
    writeBlockMap(dir, report);
    const text = formatReport(report);
    expect(text).toContain("website/sections/Analytics/Analytics.tsx");
    expect(text).toContain("GTM-ABC123");
    expect(text).toContain("G-XYZ789");
  });

  it("mig-11: the random matcher's saved-block name becomes the A/B test's experiment ID", () => {
    const dir = site({
      "package.json": { name: "site", type: "module" },
      ".deco/blocks/HeroTest.json": {
        __resolveType: "website/matchers/random.ts",
        traffic: 0.5,
      },
      ".deco/blocks/Home.json": {
        __resolveType: "website/pages/Page.tsx",
        name: "Home",
        path: "/",
        sections: {
          __resolveType: "website/flags/multivariate.ts",
          variants: [{ rule: { __resolveType: "HeroTest" }, value: [] }],
        },
      },
    });
    copyExperimentIds(dir, createReport());
    const home = JSON.parse(fs.readFileSync(path.join(dir, ".deco/blocks/Home.json"), "utf8"));
    expect(home.sections.experiment).toBe("HeroTest");
  });
});
