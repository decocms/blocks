// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decofileEntries, moveContent } from "./content";
import { rewriteImports, V8_API } from "./imports";
import { createReport } from "./report";
import { reencryptSecrets } from "./secrets";

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function site(files: Record<string, string | object>): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "blocks-migrate-")));
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
});

describe("secrets", () => {
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
});

describe("the codemod's list of the root's next-major exports", () => {
  it("matches what @decocms/blocks exports from its next-major core", () => {
    const index = fs.readFileSync(path.resolve(__dirname, "../../blocks/src/index.ts"), "utf8");
    const block = /export \{([^}]*)\} from "\.\/v8\/index";/.exec(index)?.[1] ?? "";
    const names = block
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(10);
    expect([...(V8_API["@decocms/blocks"] as Set<string>)].sort()).toEqual(names.sort());
  });
});
