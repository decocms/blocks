// @vitest-environment node
/**
 * Date windows → the saved block `campaigns` (type `date-windows`) and `date`
 * rules naming a campaign (./campaigns.ts), on fixture sites.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { campaignName, migrateDateRules } from "./campaigns";
import { renameLegacyTypes } from "./legacyNames";
import { createReport } from "./report";

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

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
const snapshot = () => {
  const dir = path.join(root, ".deco", "blocks");
  return Object.fromEntries(
    fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
};
const page = (sections: unknown) => ({
  __resolveType: "website/pages/Page.tsx",
  name: "Home",
  path: "/",
  sections,
});
const hero = (title: string) => [{ __resolveType: "site/sections/Hero.tsx", title }];
const flag = (rule: object, title = "Sale") => ({
  __resolveType: "website/flags/multivariate.ts",
  variants: [
    { rule, value: hero(title) },
    { rule: { __resolveType: "website/matchers/always.ts" }, value: hero("Default") },
  ],
});

const BF = { start: "2026-11-27T00:00:00-03:00", end: "2026-12-01T23:59:59-03:00" };

describe("campaignName", () => {
  it("is the window's days as written, either bound open", () => {
    expect(campaignName(BF)).toBe("2026-11-27 → 2026-12-01");
    expect(campaignName({ start: "2026-11-27T03:00:00.000Z" })).toBe("from 2026-11-27");
    expect(campaignName({ end: "2026-12-01" })).toBe("until 2026-12-01");
    expect(campaignName({})).toBe("always");
    expect(campaignName({ start: "next friday" })).toBe("from next friday");
  });
});

describe("saved date matchers", () => {
  it("become campaigns under their saved names; their rules name them; the matchers are deleted", () => {
    site({
      ".deco/blocks/Black%20Friday.json": { __resolveType: "website/matchers/date.ts", ...BF },
      ".deco/blocks/Home.json": page([flag({ __resolveType: "Black Friday" })]),
      // A rule nested in v7's multi matcher.
      ".deco/blocks/Footer.json": flag({
        __resolveType: "website/matchers/multi.ts",
        op: "and",
        matchers: [
          { __resolveType: "Black Friday" },
          { __resolveType: "website/matchers/device.ts", mobile: true },
        ],
      }),
    });
    const report = createReport();
    migrateDateRules(root, report);

    expect(read(".deco/blocks/campaigns.json")).toEqual({
      __resolveType: "date-windows",
      "Black Friday": BF,
    });
    expect(exists(".deco/blocks/Black%20Friday.json")).toBe(false);
    expect(read(".deco/blocks/Home.json").sections[0].variants[0].rule).toEqual({
      __resolveType: "date",
      campaign: "Black Friday",
    });
    const footer = read(".deco/blocks/Footer.json");
    expect(footer.variants[0].rule.matchers[0]).toEqual({
      __resolveType: "date",
      campaign: "Black Friday",
    });
    expect(footer.variants[0].rule.matchers[1].__resolveType).toBe("website/matchers/device.ts");
    expect(report.done.map((n) => n.subject)).toEqual(
      expect.arrayContaining(["Home.json", "Footer.json", "Black%20Friday.json", "campaigns.json"]),
    );
    expect(report.manual).toEqual([]);
  });
});

describe("inline date rules", () => {
  it("v7's and v8's become campaigns named after their window; identical windows share one", () => {
    site({
      ".deco/blocks/Home.json": page([
        flag({ __resolveType: "website/matchers/date.ts", ...BF }),
        flag({ __resolveType: "$live/matchers/MatchDate.ts", ...BF }),
        flag({ __resolveType: "date", ...BF }),
        flag({ __resolveType: "date", start: "2026-12-24T00:00:00-03:00", end: "" }),
        flag({ __resolveType: "date", end: "2026-01-10T00:00:00Z" }),
      ]),
      ".deco/blocks/Header.json": flag({ __resolveType: "date", ...BF }, "Banner"),
    });
    const report = createReport();
    migrateDateRules(root, report);

    expect(read(".deco/blocks/campaigns.json")).toEqual({
      __resolveType: "date-windows",
      "2026-11-27 → 2026-12-01": BF,
      "from 2026-12-24": { start: "2026-12-24T00:00:00-03:00" },
      "until 2026-01-10": { end: "2026-01-10T00:00:00Z" },
    });
    const rules = read(".deco/blocks/Home.json").sections.map(
      (s: { variants: { rule: unknown }[] }) => s.variants[0].rule,
    );
    const named = (campaign: string) => ({ __resolveType: "date", campaign });
    expect(rules).toEqual([
      named("2026-11-27 → 2026-12-01"),
      named("2026-11-27 → 2026-12-01"),
      named("2026-11-27 → 2026-12-01"),
      named("from 2026-12-24"),
      named("until 2026-01-10"),
    ]);
    expect(read(".deco/blocks/Header.json").variants[0].rule).toEqual(
      named("2026-11-27 → 2026-12-01"),
    );
    expect(report.manual).toEqual([]);
  });

  it("two windows on the same days get a suffix; a window a campaign already has reuses it", () => {
    const evening = { start: "2026-11-27T18:00:00-03:00", end: "2026-12-01T23:59:59-03:00" };
    site({
      ".deco/blocks/campaigns.json": {
        __resolveType: "date-windows",
        "black-friday": BF,
        "2026-11-27 → 2026-12-01": { start: "2026-11-27T12:00:00-03:00", end: BF.end },
      },
      ".deco/blocks/Home.json": page([
        flag({ __resolveType: "date", ...BF }),
        flag({ __resolveType: "date", ...evening }),
      ]),
    });
    migrateDateRules(root, createReport());
    expect(read(".deco/blocks/campaigns.json")).toEqual({
      __resolveType: "date-windows",
      "black-friday": BF,
      "2026-11-27 → 2026-12-01": { start: "2026-11-27T12:00:00-03:00", end: BF.end },
      "2026-11-27 → 2026-12-01 (2)": evening,
    });
    const campaigns = read(".deco/blocks/Home.json").sections.map(
      (s: { variants: { rule: { campaign: string } }[] }) => s.variants[0].rule.campaign,
    );
    expect(campaigns).toEqual(["black-friday", "2026-11-27 → 2026-12-01 (2)"]);
  });

  it("a saved matcher's name taken by another window gets a suffix", () => {
    site({
      ".deco/blocks/campaigns.json": {
        __resolveType: "date-windows",
        Sale: { start: "2025-01-01" },
      },
      ".deco/blocks/Sale.json": { __resolveType: "website/matchers/date.ts", ...BF },
      ".deco/blocks/Home.json": page([flag({ __resolveType: "Sale" })]),
    });
    migrateDateRules(root, createReport());
    expect(read(".deco/blocks/campaigns.json")).toEqual({
      __resolveType: "date-windows",
      Sale: { start: "2025-01-01" },
      "Sale (2)": BF,
    });
    expect(read(".deco/blocks/Home.json").sections[0].variants[0].rule).toEqual({
      __resolveType: "date",
      campaign: "Sale (2)",
    });
  });

  it("leaves rules that already name a campaign", () => {
    const files = {
      ".deco/blocks/campaigns.json": { __resolveType: "date-windows", "black-friday": BF },
      ".deco/blocks/Home.json": page([flag({ __resolveType: "date", campaign: "black-friday" })]),
    };
    site(files);
    const before = snapshot();
    const report = createReport();
    migrateDateRules(root, report);
    expect(snapshot()).toEqual(before);
    expect(report).toEqual(createReport());
  });

  it("keeps a rule whose bound isn't a string inline, and reports it", () => {
    site({
      ".deco/blocks/Home.json": page([
        flag({ __resolveType: "date", start: { __resolveType: "Some loader" } }),
      ]),
    });
    const report = createReport();
    migrateDateRules(root, report);
    expect(exists(".deco/blocks/campaigns.json")).toBe(false);
    expect(read(".deco/blocks/Home.json").sections[0].variants[0].rule.start).toEqual({
      __resolveType: "Some loader",
    });
    expect(report.manual).toEqual([
      expect.objectContaining({
        subject: "Home.json",
        message: expect.stringContaining("isn't a date string"),
      }),
    ]);
  });
});

describe("running it again", () => {
  it("after the legacy renames, changes nothing", () => {
    site({
      ".deco/blocks/Black%20Friday.json": { __resolveType: "$live/matchers/MatchDate.ts", ...BF },
      ".deco/blocks/Home.json": page([
        flag({ __resolveType: "Black Friday" }),
        flag({ __resolveType: "website/matchers/date.ts", start: "2026-12-24" }),
        flag({ __resolveType: "date", ...BF }),
      ]),
    });
    renameLegacyTypes(root, createReport());
    migrateDateRules(root, createReport());
    expect(read(".deco/blocks/campaigns.json")).toEqual({
      __resolveType: "date-windows",
      "Black Friday": BF,
      "from 2026-12-24": { start: "2026-12-24" },
    });
    // The inline window identical to the saved matcher's shares its campaign.
    expect(read(".deco/blocks/Home.json").sections[2].variants[0].rule).toEqual({
      __resolveType: "date",
      campaign: "Black Friday",
    });
    const before = snapshot();
    const again = createReport();
    renameLegacyTypes(root, again);
    migrateDateRules(root, again);
    expect(snapshot()).toEqual(before);
    expect(again).toEqual(createReport());
  });
});

describe("a block saved under the campaigns name", () => {
  it("of another type is left alone, with everything else, and the note says why", () => {
    const files = {
      ".deco/blocks/campaigns.json": { __resolveType: "site/sections/Hero.tsx" },
      ".deco/blocks/Home.json": page([flag({ __resolveType: "date", ...BF })]),
    };
    site(files);
    const report = createReport();
    migrateDateRules(root, report);
    expect(read(".deco/blocks/campaigns.json")).toEqual(files[".deco/blocks/campaigns.json"]);
    expect(read(".deco/blocks/Home.json")).toEqual(files[".deco/blocks/Home.json"]);
    expect(report.done).toEqual([]);
    expect(report.manual[0].message).toContain("rename this block");
  });

  it("in another case is left alone too (a case-insensitive disk shares the file)", () => {
    site({
      ".deco/blocks/Campaigns.json": { __resolveType: "site/sections/Hero.tsx" },
      ".deco/blocks/Home.json": page([flag({ __resolveType: "date", ...BF })]),
    });
    const report = createReport();
    migrateDateRules(root, report);
    expect(exists(".deco/blocks/campaigns.json")).toBe(false);
    expect(report.manual[0]).toMatchObject({
      subject: "Campaigns.json",
      message: expect.stringContaining("case-insensitive"),
    });
  });
});
