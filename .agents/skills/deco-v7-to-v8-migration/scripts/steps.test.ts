// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unwrapAsyncRendering } from "./asyncRendering";
import { writeBlockMap } from "./blockMap";
import { decofileEntries, moveContent } from "./content";
import { copyExperimentIds } from "./experiments";
import { rewriteImports, V8_API } from "./imports";
import { renameLegacyTypes } from "./legacyNames";
import { createReport } from "./report";
import { reencryptSecrets } from "./secrets";
import { foldSiteSettings } from "./siteSettings";
import { locateAppModule, vendorModule } from "./vendor";

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

const home = { __resolveType: "website/pages/Page.tsx", name: "Home", path: "/", sections: [] };

describe("async rendering", () => {
  const LAZY = "website/sections/Rendering/Lazy.tsx";
  const DEFERRED = "website/sections/Rendering/Deferred.tsx";
  // storefront-tanstack's home: a ProductShelfTabbed behind v7's Lazy wrapper.
  const shelf = {
    __resolveType: "site/sections/Product/ProductShelfTabbed.tsx",
    title: "Hottest Deals",
    tabs: [
      {
        title: "Accessories",
        products: { __resolveType: "shopify/loaders/ProductList.ts", props: { count: 10 } },
      },
    ],
  };
  const hero = { __resolveType: "site/sections/Hero.tsx", title: "Hi" };
  const footer = { __resolveType: "Footer" };

  it("replaces each wrapper with the section(s) it held, props untouched; a second run changes nothing", () => {
    site({
      ".deco/blocks/pages-home.json": {
        ...home,
        sections: [
          { __resolveType: LAZY, section: shelf, loading: "lazy" },
          { __resolveType: DEFERRED, sections: [hero, { __resolveType: LAZY, section: footer }] },
          { __resolveType: "website/sections/Rendering/SingleDeferred.tsx", section: hero },
          { __resolveType: LAZY },
        ],
      },
      ".deco/blocks/Lazy%20Footer.json": { __resolveType: LAZY, section: footer },
      ".deco/blocks/Banner.json": {
        __resolveType: "site/sections/Banner.tsx",
        slot: { __resolveType: LAZY, section: hero },
      },
      ".deco/blocks/Plain.json": hero,
    });
    const report = createReport();
    unwrapAsyncRendering(root, report);
    const read = (file: string) =>
      JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks", file), "utf8"));
    // In a list, a Deferred gives way to all its sections in place; an empty wrapper goes.
    expect(read("pages-home.json").sections).toEqual([shelf, hero, footer, hero]);
    expect(read("Lazy%20Footer.json")).toEqual(footer);
    expect(read("Banner.json")).toEqual({ __resolveType: "site/sections/Banner.tsx", slot: hero });
    expect(report.done.map((n) => n.subject).sort()).toEqual([
      "Banner.json",
      "Lazy%20Footer.json",
      "pages-home.json",
    ]);
    expect(report.manual).toEqual([]);

    const again = createReport();
    unwrapAsyncRendering(root, again);
    expect(again).toEqual({ done: [], manual: [] });
  });

  it("reports a wrapper holding several sections where one block goes, unwrapping inside it", () => {
    site({
      ".deco/blocks/Slot.json": {
        __resolveType: DEFERRED,
        sections: [{ __resolveType: LAZY, section: hero }, footer],
      },
    });
    const report = createReport();
    unwrapAsyncRendering(root, report);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks/Slot.json"), "utf8"))).toEqual({
      __resolveType: DEFERRED,
      sections: [hero, footer],
    });
    expect(report.manual.map((n) => n.subject)).toEqual([`${DEFERRED} (in Slot.json)`]);
  });
});

describe("content", () => {
  it("reads a decofile flat or under blocks", () => {
    expect(decofileEntries({ Home: home })).toEqual({ Home: home });
    expect(decofileEntries({ blocks: { Home: home }, revision: "x" })).toEqual({ Home: home });
  });

  it("splits a decofile into .deco/blocks by the file-name rule, and reports names it rejects", () => {
    site({
      ".deco/blocks.gen.json": { "pages/home page": home, "Preview site/sections/Hero.tsx": home },
    });
    const report = createReport();
    moveContent(root, report);
    expect(fs.readdirSync(path.join(root, ".deco/blocks"))).toEqual(["pages%2Fhome%20page.json"]);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks/pages%2Fhome%20page.json"), "utf8")),
    ).toEqual(home);
    expect(fs.existsSync(path.join(root, ".deco/blocks.gen.json"))).toBe(false);
    expect(report.manual.map((n) => n.subject)).toEqual(["Preview site/sections/Hero.tsx"]);
  });

  it("keeps .deco/blocks as it is when it has content", () => {
    site({ ".deco/blocks/Home.json": home, ".decofile.json": { Other: home } });
    moveContent(root, createReport());
    expect(fs.readdirSync(path.join(root, ".deco/blocks"))).toEqual(["Home.json"]);
  });

  it("refuses --decofile when .deco/blocks already has content", () => {
    site({ ".deco/blocks/Home.json": home, "live.json": { Other: home } });
    expect(() => moveContent(root, createReport(), { decofile: "live.json" })).toThrow(
      "--decofile given but .deco/blocks already has content",
    );
  });
});

describe("legacy type names", () => {
  it("rewrites names outside the alias table to ones the next major resolves", () => {
    site({
      ".deco/blocks/Home.json": {
        ...home,
        sections: [
          {
            __resolveType: "website/flags/multivariate/image.ts",
            variants: [
              { rule: { __resolveType: "$live/matchers/MatchAlways.ts" }, value: "a.png" },
            ],
          },
          { __resolveType: "website/matchers/date.ts", start: "2026-01-01" },
        ],
      },
      ".deco/blocks/Untouched.json": home,
    });
    const report = createReport();
    renameLegacyTypes(root, report);
    const saved = JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks/Home.json"), "utf8"));
    expect(saved.sections[0].__resolveType).toBe("website/flags/multivariate.ts");
    expect(saved.sections[0].variants[0].rule.__resolveType).toBe("website/matchers/always.ts");
    expect(saved.sections[1].__resolveType).toBe("date");
    expect(report.done.map((n) => n.subject)).toEqual(["Home.json"]);
  });
});

describe("experiments", () => {
  it("copies the random matcher's saved name into multivariate's experiment", () => {
    const variants = [
      { rule: { __resolveType: "Test AB" }, value: "B" },
      { rule: { __resolveType: "website/matchers/always.ts" }, value: "A" },
    ];
    site({
      ".deco/blocks/Test%20AB.json": { __resolveType: "website/matchers/random.ts", traffic: 0.5 },
      ".deco/blocks/Home.json": {
        ...home,
        sections: [
          { __resolveType: "website/flags/multivariate.ts", variants },
          { __resolveType: "multivariate", experiment: "kept", variants },
          { __resolveType: "website/flags/multivariate.ts", variants: [variants[1]] },
        ],
      },
    });
    const report = createReport();
    copyExperimentIds(root, report);
    const saved = JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks/Home.json"), "utf8"));
    expect(saved.sections.map((s: { experiment?: string }) => s.experiment)).toEqual([
      "Test AB",
      "kept",
      undefined,
    ]);
    expect(report.done).toHaveLength(1);
  });
});

describe("secrets", () => {
  it("reports a v7 secret with no encrypted value", async () => {
    site({
      ".deco/blocks/Key.json": { __resolveType: "website/loaders/secret.ts", name: "ACME_KEY" },
    });
    const report = createReport();
    await reencryptSecrets(root, report);
    expect(report.manual).toEqual([
      expect.objectContaining({
        subject: "Key.json",
        message: expect.stringContaining("no encrypted value (it read env ACME_KEY)"),
      }),
    ]);
  });

  it("leaves v7 secrets in place, reported, without a public key", async () => {
    const secret = { __resolveType: "website/loaders/secret.ts", encrypted: "abcd", name: "KEY" };
    site({ ".deco/blocks/App.json": { __resolveType: "site/apps/x.ts", token: secret } });
    const report = createReport();
    await reencryptSecrets(root, report);
    expect(report.manual).toEqual([
      expect.objectContaining({
        step: "secrets",
        subject: "App.json",
        message: expect.stringContaining("create the key pair"),
      }),
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks/App.json"), "utf8")).token,
    ).toEqual(secret);
  });
});

describe("content can't write outside the site", () => {
  it("doesn't vendor or register a type name that climbs out of its folder", () => {
    site({
      "node_modules/@decocms/apps-acme/package.json": { name: "@decocms/apps-acme" },
      "node_modules/@decocms/apps-acme/src/loaders/A.ts": "export default () => 1;\n",
      "node_modules/@decocms/apps-acme/outside.ts": "export default () => 1;\n",
      "src/x.ts": "export default () => 1;\n",
      ".deco/blocks/Home.json": {
        ...home,
        sections: [
          { __resolveType: "acme/../outside.ts" },
          { __resolveType: "acme/loaders/../../outside.ts" },
          { __resolveType: "site/../src/x.ts" },
        ],
      },
    });
    expect(locateAppModule(root, "acme/loaders/A.ts")).toBeDefined();
    expect(locateAppModule(root, "acme/loaders/../../outside.ts")).toBeUndefined();
    const report = createReport();
    writeBlockMap(root, report);
    expect(fs.existsSync(path.join(root, "src/vendor"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".deco/index.ts"), "utf8")).not.toMatch(
      /outside|src\/x/,
    );
    expect(report.manual.filter((n) => n.step === "block map")).toHaveLength(3);
  });
});

describe("vendoring", () => {
  it("copies a JSON file the module imports, and reports an import that doesn't resolve", () => {
    site({
      "node_modules/@decocms/apps-acme/package.json": { name: "@decocms/apps-acme" },
      "node_modules/@decocms/apps-acme/src/loaders/A.ts":
        'import limits from "../limits.json" with { type: "json" };\nimport "./missing.css";\nexport default () => limits;\n',
      "node_modules/@decocms/apps-acme/src/limits.json": { max: 50 },
    });
    const report = createReport();
    const module = locateAppModule(root, "acme/loaders/A.ts")!;
    vendorModule(root, module, new Map(), report);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "src/vendor/acme/limits.json"), "utf8")),
    ).toEqual({ max: 50 });
    expect(report.manual.map((n) => n.message)).toEqual([
      "imports ./missing.css, which doesn't resolve to a file; fix the import",
    ]);
  });
});

describe("imports", () => {
  it("rewrites createInstrumentedFetch only when every call passes a provider name", () => {
    site({
      "src/a.ts":
        'import { createInstrumentedFetch } from "@decocms/blocks/sdk/instrumentedFetch";\nexport const f = createInstrumentedFetch("vtex");\n',
      "src/b.ts":
        'import { createInstrumentedFetch } from "@decocms/blocks/sdk/instrumentedFetch";\nexport const f = createInstrumentedFetch({ name: "vtex" });\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toBe(
      'import { createInstrumentedFetch } from "@decocms/blocks/fetch";\nexport const f = createInstrumentedFetch({ provider: "vtex" });\n',
    );
    expect(fs.readFileSync(path.join(root, "src/b.ts"), "utf8")).toContain(
      "@decocms/blocks/sdk/instrumentedFetch",
    );
    expect(report.manual.map((n) => n.subject)).toEqual([
      "@decocms/blocks/sdk/instrumentedFetch {createInstrumentedFetch}",
    ]);
  });

  it("keeps the next major's API and reports v7 names imported from the same entry point", () => {
    site({
      "src/a.ts":
        'import { createCMS, type Blocks } from "@decocms/blocks";\nimport { track } from "@decocms/blocks/analytics";\n',
      "src/b.tsx":
        'import { logger } from "@decocms/blocks";\nconst x = import("@decocms/apps-salesforce");\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(report.manual.map((n) => `${n.subject}: ${n.message}`)).toEqual([
      "@decocms/apps-salesforce {*}: the Salesforce client is @decocms/apps-sfmc-personalization (/next/upstream-clients#what-a-client-is); in src/b.tsx:2",
      "@decocms/blocks {logger}: no v8 equivalent; in src/b.tsx:1",
    ]);
  });

  it("points prerelease draft helpers at the CMS methods", () => {
    site({
      "src/a.ts": 'import { createCMS, draftPointer, DRAFT_COOKIE } from "@decocms/blocks";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(report.manual).toHaveLength(1);
    expect(report.manual[0]?.message).toContain("cms.draftPointer");
  });

  it("reports every framework-binding import, kvLoader included: the next major has no binding", () => {
    site({
      "src/a.ts":
        'import { kvLoader } from "@decocms/tanstack";\nimport { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    const notes = report.manual.map((n) => `${n.subject}: ${n.message}`);
    expect(notes.map((n) => n.split(":")[0])).toEqual([
      "@decocms/nextjs/routeHandlers {createDecoRouteHandlers}",
      "@decocms/tanstack {kvLoader}",
    ]);
    for (const note of notes) expect(note).toContain("drop the dependency");
  });
});

describe("the codemod's list of the root's next-major exports", () => {
  it("matches what @decocms/blocks exports from its next-major core", () => {
    const index = fs.readFileSync(
      path.resolve(__dirname, "../../../../packages/blocks/src/index.ts"),
      "utf8",
    );
    const block = /export \{([^}]*)\} from "\.\/v8\/index\.ts";/.exec(index)?.[1] ?? "";
    const names = block
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(10);
    expect([...(V8_API["@decocms/blocks"] as Set<string>)].sort()).toEqual(names.sort());
  });
});

describe("site settings", () => {
  const read = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(root, ".deco/blocks", file), "utf8"));
  const exists = (file: string) => fs.existsSync(path.join(root, ".deco/blocks", file));
  const snapshotDir = () =>
    Object.fromEntries(
      fs
        .readdirSync(path.join(root, ".deco/blocks"))
        .sort()
        .map((f) => [f, fs.readFileSync(path.join(root, ".deco/blocks", f), "utf8")]),
    );

  it("folds a v7 site's preview hosts and OneDollarStats collector into CMS.json; a second run changes nothing", () => {
    site({
      "package.json": { name: "site" },
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        theme: { primary: "#000" },
        previewHosts: ["staging.example.com", "localhost:5173"],
      },
      ".deco/blocks/pages-home.json": home,
      "src/routes/__root.tsx": `import { OneDollarStats } from "@decocms/apps-website/components/OneDollarStats";
export function Root() {
  return <html><body><OneDollarStats collectorAddress="https://stats.example.com/events" /></body></html>;
}
`,
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(read("CMS.json")).toEqual({
      __resolveType: "cms-settings",
      preview: { hosts: ["staging.example.com", "localhost:5173"] },
      analytics: { collector: "https://stats.example.com/events" },
    });
    // previewHosts moved; the rest of the Site block stays.
    expect(read("site.json")).toEqual({
      __resolveType: "site/apps/site.ts",
      theme: { primary: "#000" },
    });
    expect(report.done.map((n) => n.subject)).toEqual([".deco/blocks/CMS.json"]);
    const manual = report.manual.map((n) => n.subject);
    expect(manual).toContain("DECO_ALLOWED_PREVIEW_HOSTS");
    expect(manual).toContain("DECO_OTEL_* sampling");
    expect(manual).toContain("DECO_ANALYTICS_ENABLED, ONEDOLLAR_ENABLED, ONEDOLLAR_COLLECTOR");
    expect(manual).not.toContain("preview hosts");

    const before = snapshotDir();
    const again = createReport();
    foldSiteSettings(root, again);
    expect(snapshotDir()).toEqual(before);
    expect(again.done).toEqual([]);
  });

  it("trims and lowercases v7's entries, and reports one that isn't a host", () => {
    site({
      "package.json": { name: "site" },
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        previewHosts: [
          " Staging.Example.com ",
          "localhost:3100",
          "https://bad.example.com/",
          "*.x.com",
        ],
      },
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(read("CMS.json").preview).toEqual({ hosts: ["staging.example.com", "localhost:3100"] });
    const bad = report.manual.filter((n) => n.subject === ".deco/blocks/site.json");
    expect(bad.map((n) => n.message).join("\n")).toContain("https://bad.example.com/");
    expect(bad.map((n) => n.message).join("\n")).toContain("*.x.com");
  });

  it("on TanStack Start, adds the deco-hosted hosts v7 allowed for DECO_SITE_NAME", () => {
    site({
      "package.json": { name: "site", dependencies: { "@decocms/tanstack": "7.0.0" } },
      "wrangler.jsonc": `{ "vars": { "DECO_SITE_NAME": "acme" } }`,
      ".env": "DECO_SITE_NAME=other\n",
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        previewHosts: ["staging.example.com", "acme.deco.site"],
      },
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(read("CMS.json").preview).toEqual({
      hosts: ["staging.example.com", "acme.deco.site", "acme.deco-cx.workers.dev"],
    });
    expect(report.manual.map((n) => n.subject)).not.toContain("preview hosts");
    const before = snapshotDir();
    foldSiteSettings(root, createReport());
    expect(snapshotDir()).toEqual(before);
  });

  it("on TanStack Start without a site name, reports the deco-hosted hosts; a Next.js site never gets them", () => {
    site({
      "package.json": { name: "site", dependencies: { "@decocms/tanstack": "7.0.0" } },
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        previewHosts: ["a.example.com"],
      },
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(read("CMS.json").preview).toEqual({ hosts: ["a.example.com"] });
    const note = report.manual.find((n) => n.subject === "preview hosts");
    expect(note?.message).toContain("<site>.deco.site");

    fs.rmSync(root, { recursive: true, force: true });
    site({
      "package.json": { name: "site", dependencies: { "@decocms/nextjs": "7.0.0" } },
      ".env": "DECO_SITE_NAME=acme\n",
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        previewHosts: ["a.example.com"],
      },
    });
    const next = createReport();
    foldSiteSettings(root, next);
    expect(read("CMS.json").preview).toEqual({ hosts: ["a.example.com"] });
    expect(next.manual.map((n) => n.subject)).not.toContain("preview hosts");
  });

  it("with no previewHosts on a named TanStack site, says v7 allowed only its deco-hosted hosts", () => {
    site({
      "package.json": { name: "site", dependencies: { "@decocms/tanstack": "7.0.0" } },
      ".env": "DECO_SITE_NAME=acme\n",
      ".deco/blocks/pages-home.json": home,
    });
    const report = createReport();
    foldSiteSettings(root, report);
    const note = report.manual.find((n) => n.subject === "preview hosts");
    expect(note?.message).toContain("acme.deco.site and acme.deco-cx.workers.dev");
    expect(note?.message).not.toContain("kept previews off");
  });

  it("reads a Site block named Site, and collectorAddress={'…'}", () => {
    site({
      "package.json": { name: "site" },
      ".deco/blocks/Site.json": { __resolveType: "site/apps/site.ts", previewHosts: [] },
      "src/app/layout.tsx": `<OneDollarStats collectorAddress={'https://c.example/e'} />`,
    });
    foldSiteSettings(root, createReport());
    expect(read("CMS.json")).toEqual({
      __resolveType: "cms-settings",
      preview: { hosts: [] },
      analytics: { collector: "https://c.example/e" },
    });
  });

  it("folds prerelease Telemetry.json and Analytics.json field for field, variants included, and deletes them", () => {
    const variants = {
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "date", start: "2026-11-01" },
          value: { __resolveType: "lazy", value: { __resolveType: "analytics", enabled: true } },
        },
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: { __resolveType: "analytics", enabled: false } },
        },
      ],
    };
    site({
      "package.json": { name: "site" },
      ".deco/blocks/Telemetry.json": {
        __resolveType: "telemetry",
        enabled: true,
        errorSampleRate: { __resolveType: "Rates" },
        traceSampleRate: 0,
      },
      ".deco/blocks/Analytics.json": variants,
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(exists("Telemetry.json")).toBe(false);
    expect(exists("Analytics.json")).toBe(false);
    expect(read("CMS.json")).toEqual({
      __resolveType: "cms-settings",
      telemetry: { enabled: true, errorSampleRate: { __resolveType: "Rates" }, traceSampleRate: 0 },
      analytics: {
        __resolveType: "multivariate",
        variants: [
          {
            rule: { __resolveType: "date", start: "2026-11-01" },
            value: { __resolveType: "lazy", value: { enabled: true } },
          },
          {
            rule: { __resolveType: "always" },
            value: { __resolveType: "lazy", value: { enabled: false } },
          },
        ],
      },
    });
    // A prerelease site with no preview hosts gets the behaviour-change note.
    expect(report.manual.map((n) => n.subject)).toContain("preview hosts");
    const before = snapshotDir();
    foldSiteSettings(root, createReport());
    expect(snapshotDir()).toEqual(before);
  });

  it("keeps what CMS.json already has, and adds only what's missing", () => {
    site({
      "package.json": { name: "site" },
      ".deco/blocks/CMS.json": {
        __resolveType: "cms-settings",
        preview: { hosts: ["kept.example.com"] },
        telemetry: { metrics: false },
      },
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        previewHosts: ["v7.example.com"],
      },
      ".deco/blocks/Telemetry.json": {
        __resolveType: "telemetry",
        metrics: true,
        errorSampleRate: 0.01,
      },
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(read("CMS.json")).toEqual({
      __resolveType: "cms-settings",
      preview: { hosts: ["kept.example.com"] },
      telemetry: { metrics: false, errorSampleRate: 0.01 },
    });
    expect(exists("Telemetry.json")).toBe(false);
    // The Site block's different list is left for a person, untouched.
    expect(read("site.json").previewHosts).toEqual(["v7.example.com"]);
    expect(report.manual.map((n) => n.subject)).toContain(".deco/blocks/site.json");
  });

  it("writes nothing when there's nothing to fold; a v7 Analytics section named Analytics is left alone", () => {
    site({
      "package.json": { name: "site" },
      ".deco/blocks/pages-home.json": home,
      ".deco/blocks/Analytics.json": {
        __resolveType: "website/sections/Analytics/Analytics.tsx",
        trackingIds: ["GTM-1"],
      },
    });
    const before = snapshotDir();
    const report = createReport();
    foldSiteSettings(root, report);
    expect(snapshotDir()).toEqual(before);
    expect(report.done).toEqual([]);
    expect(report.manual.map((n) => n.subject)).toContain("preview hosts");
  });

  it("never replaces a CMS block of another type; leftover telemetry/analytics blocks are reported", () => {
    site({
      "package.json": { name: "site" },
      ".deco/blocks/CMS.json": { __resolveType: "site/sections/Cms.tsx" },
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        previewHosts: ["a.example.com"],
      },
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(read("CMS.json")).toEqual({ __resolveType: "site/sections/Cms.tsx" });
    expect(report.done).toEqual([]);
    expect(report.manual[0]?.message).toContain("rename");

    site({
      "package.json": { name: "site" },
      ".deco/blocks/OtherTelemetry.json": { __resolveType: "telemetry", enabled: false },
    });
    const leftovers = createReport();
    foldSiteSettings(root, leftovers);
    expect(exists("OtherTelemetry.json")).toBe(true);
    expect(leftovers.manual.map((n) => n.subject)).toContain(".deco/blocks/OtherTelemetry.json");
  });

  it("several collectors, or one that isn't a literal, are left for a person", () => {
    site({
      "package.json": { name: "site" },
      "src/a.tsx": `<OneDollarStats collectorAddress="https://a.example/e" />`,
      "src/b.tsx": `<OneDollarStats collectorAddress="https://b.example/e" />`,
      "src/c.tsx": "<OneDollarStats collectorAddress={env.COLLECTOR} />",
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(fs.existsSync(path.join(root, ".deco/blocks/CMS.json"))).toBe(false);
    const subjects = report.manual.map((n) => n.subject);
    expect(subjects).toContain("OneDollarStats collectorAddress");
    expect(subjects).toContain("src/c.tsx");
  });
});
