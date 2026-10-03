// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBlockMap } from "./blockMap";
import { decofileEntries, moveContent } from "./content";
import { copyExperimentIds } from "./experiments";
import { rewriteImports, V8_API } from "./imports";
import { renameLegacyTypes } from "./legacyNames";
import { createReport } from "./report";
import { reencryptSecrets } from "./secrets";
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
