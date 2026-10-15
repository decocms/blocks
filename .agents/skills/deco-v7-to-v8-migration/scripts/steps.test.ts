// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unwrapAsyncRendering } from "./asyncRendering";
import { writeBlockMap } from "./blockMap";
import { decofileEntries, moveContent } from "./content";
import { copyExperimentIds } from "./experiments";
import { siteBlocksVersion } from "./framework";
import { BINDING_NAMES, MOVES, rewriteImports, V8_API, v7ImageUrl } from "./imports";
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

  it("points prerelease draft helpers at the CMS methods, and the draft names at the binding", () => {
    site({
      "src/a.ts": 'import { createCMS, draftPointer, DRAFT_COOKIE } from "@decocms/blocks";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(report.manual.map((n) => n.subject)).toEqual([
      "@decocms/blocks {draftPointer}",
      "@decocms/blocks {DRAFT_COOKIE}",
    ]);
    expect(report.manual[0]?.message).toContain("cms.draftPointer");
    // No binding in package.json: reported, since the home depends on the binding.
    expect(report.manual[1]?.message).toContain("@decocms/tanstack on TanStack Start");
  });

  it.each([
    ["@decocms/tanstack", "@decocms/tanstack"],
    ["@decocms/nextjs", "@decocms/nextjs"],
  ])("on a %s site, moves the draft names and Studio's origins from @decocms/blocks to %s", (binding, target) => {
    site({
      "package.json": { name: "site", dependencies: { [binding]: "7.0.0" } },
      "src/a.ts":
        'import { createCMS, DRAFT_COOKIE, STUDIO_ORIGINS, isStudioOrigin } from "@decocms/blocks";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toBe(
      `import { DRAFT_COOKIE, STUDIO_ORIGINS, isStudioOrigin } from "${target}";\nimport { createCMS } from "@decocms/blocks";\n`,
    );
    expect(report.manual).toEqual([]);
  });

  it("reports v7 binding imports name by name, with the v8 binding's replacement", () => {
    site({
      "src/a.ts":
        'import { kvLoader, createDecoWorkerEntry } from "@decocms/tanstack";\nimport { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";\nimport { LiveControls, registerImageQuality } from "@decocms/blocks/hooks";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    const notes = report.manual.map((n) => `${n.subject}: ${n.message}`);
    expect(notes.map((n) => n.split(":")[0])).toEqual([
      "@decocms/blocks/hooks {LiveControls}",
      "@decocms/blocks/hooks {registerImageQuality}",
      "@decocms/nextjs/routeHandlers {createDecoRouteHandlers}",
      "@decocms/tanstack {createDecoWorkerEntry}",
      "@decocms/tanstack {kvLoader}",
    ]);
    const note = (subject: string) => notes.find((n) => n.startsWith(subject)) ?? "";
    expect(note("@decocms/tanstack {createDecoWorkerEntry}")).toContain(
      "createDecoWorker({ serverEntry, cms, site, buildHash }) from @decocms/tanstack/worker",
    );
    expect(note("@decocms/tanstack {kvLoader}")).toContain("createCMS({ site, token })");
    expect(note("@decocms/blocks/hooks {LiveControls}")).toContain("StudioBridge");
    expect(note("@decocms/blocks/hooks {registerImageQuality}")).toContain("ImageUrlProvider");
    // Platform image URLs come from the platforms' client packages, never @decocms/blocks/image.
    expect(note("@decocms/blocks/hooks {registerImageQuality}")).toContain(
      "vtexCatalog from @decocms/apps-vtex/image, shopifyCdn from @decocms/apps-shopify/image",
    );
    expect(note("@decocms/nextjs/routeHandlers")).toContain("delete them");
  });

  it("moves names the v8 bindings export unchanged, splitting a mixed import", () => {
    site({
      "package.json": { name: "site", dependencies: { "@decocms/tanstack": "7.0.0" } },
      "src/router.tsx":
        'import { createDecoRouter, NavigationProgress, StableOutlet, DecoRootLayout } from "@decocms/tanstack";\n',
      "src/start.ts": "import { decoServerFnFetch } from '@decocms/tanstack/sdk/serverFnFetch';\n",
      "src/Banner.tsx":
        'import { Image, Picture, Source, type ImageProps, LiveControls } from "@decocms/blocks/hooks";\n',
      "src/v8.ts":
        'import { createDecoWorker } from "@decocms/tanstack/worker";\nimport { decoTanstack } from "@decocms/tanstack/vite";\nimport { createImageUrl } from "@decocms/blocks/image";\nimport { DraftBadge } from "@decocms/blocks/preview";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
    expect(read("src/router.tsx")).toBe(
      [
        'import { createDecoRouter } from "@decocms/tanstack/router";',
        'import { NavigationProgress, StableOutlet } from "@decocms/tanstack/react";',
        'import { DecoRootLayout } from "@decocms/tanstack";',
        "",
      ].join("\n"),
    );
    expect(read("src/start.ts")).toBe(
      "import { decoServerFnFetch } from '@decocms/tanstack/start';\n",
    );
    expect(read("src/Banner.tsx")).toBe(
      [
        'import { Image, Picture, Source, type ImageProps } from "@decocms/tanstack/react";',
        'import { LiveControls } from "@decocms/blocks/hooks";',
        "",
      ].join("\n"),
    );
    // Only what's left is reported; the v8 imports are not. The image URLs are written
    // (src/imageUrl.ts, the latest 7.x's with no version known), but no createDecoRouter call
    // here takes them.
    expect(report.manual.map((n) => n.subject)).toEqual([
      "src/imageUrl.ts",
      "ImageUrlProvider",
      "@decocms/blocks/hooks {LiveControls}",
      "@decocms/tanstack {DecoRootLayout}",
    ]);
    expect(report.done.map((n) => n.subject)).toEqual([
      "src/",
      "@decocms/tanstack/react",
      "@decocms/tanstack/router",
      "@decocms/tanstack/start",
      "src/imageUrl.ts",
    ]);
  });

  it("leaves Image on a Next.js site to the image loader", () => {
    site({
      "package.json": { name: "site", dependencies: { "@decocms/nextjs": "7.0.0" } },
      "src/a.tsx": 'import { Image } from "@decocms/blocks/hooks";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(fs.readFileSync(path.join(root, "src/a.tsx"), "utf8")).toContain(
      "@decocms/blocks/hooks",
    );
    expect(report.manual[0]?.message).toContain("createDecoImageLoader");
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

describe("the codemod's lists of the v8 bindings' and subpaths' exports", () => {
  const PACKAGES = path.resolve(__dirname, "../../../../packages");
  const entry = (specifier: string) => {
    const [, pkg, sub] = /^@decocms\/([^/]+)(?:\/(.+))?$/.exec(specifier) ?? [];
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGES, pkg, "package.json"), "utf8"));
    const target = manifest.exports[sub ? `./${sub}` : "."];
    expect(target, specifier).toBeDefined();
    // The file a type-checker reads: the source, else the declarations of a CommonJS entry.
    const file = target.source ?? target.default?.source ?? target.workerd?.source ?? target.types;
    return path.join(PACKAGES, pkg, file);
  };
  const v8Entries = Object.entries(V8_API).filter(([s]) => s !== "@decocms/blocks");

  it.each(v8Entries)("%s exists, and exports every name listed", (specifier, api) => {
    const text = fs.readFileSync(entry(specifier), "utf8");
    if (api === "*") return;
    for (const name of api)
      expect(text, `${specifier} ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("every name a binding's root, /preview or /image exports at runtime is listed, or reported on purpose", async () => {
    const REPORTED = new Set(["DraftPreviewIndicator"]);
    for (const specifier of [
      "@decocms/tanstack",
      "@decocms/nextjs",
      "@decocms/blocks/preview",
      "@decocms/blocks/image",
    ]) {
      const api = V8_API[specifier] as Set<string>;
      const runtime = Object.keys(await import(specifier));
      expect(
        runtime.filter((n) => !api.has(n) && !REPORTED.has(n)),
        specifier,
      ).toEqual([]);
    }
  });

  it("every move points at a v8 entry that exports the name", () => {
    for (const { names } of Object.values(MOVES)) {
      for (const [name, to] of Object.entries(names)) {
        for (const target of typeof to === "string" ? [to] : Object.values(to)) {
          const api = V8_API[target];
          expect(api === "*" || api?.has(name), `${target} ${name}`).toBe(true);
          expect(fs.readFileSync(entry(target), "utf8"), `${target} ${name}`).toMatch(
            new RegExp(`\\b${name}\\b`),
          );
        }
      }
    }
  });

  it("@decocms/blocks exports none of the names that moved to the bindings", async () => {
    const runtime = Object.keys(await import("@decocms/blocks"));
    expect(runtime.filter((n) => BINDING_NAMES.includes(n))).toEqual([]);
    expect(
      [...(V8_API["@decocms/blocks"] as Set<string>)].filter((n) => BINDING_NAMES.includes(n)),
    ).toEqual([]);
  });

  it("@decocms/blocks/image names no commerce platform; the platforms' helpers are their clients' /image", () => {
    const names = [...(V8_API["@decocms/blocks/image"] as Set<string>)];
    expect(names.filter((n) => /vtex|shopify/i.test(n))).toEqual([]);
    expect(fs.readFileSync(entry("@decocms/apps-vtex/image"), "utf8")).toMatch(
      /export function vtexCatalog\b/,
    );
    expect(fs.readFileSync(entry("@decocms/apps-shopify/image"), "utf8")).toMatch(
      /export function shopifyCdn\b/,
    );
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

  it("on TanStack Start, writes only the site's own hosts and names the site the worker needs", () => {
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
    // The Deco hosts come from createDecoWorker's site, not from content.
    expect(read("CMS.json").preview).toEqual({ hosts: ["staging.example.com", "acme.deco.site"] });
    const note = report.manual.find((n) => n.subject === "preview hosts")?.message ?? "";
    expect(note).toContain('pass site: "acme" to createDecoWorker');
    expect(note).toContain("acme.deco-cx.workers.dev");
    expect(note).not.toContain("previewHosts: []");
    const allowed = report.manual.find((n) => n.subject === "DECO_ALLOWED_PREVIEW_HOSTS")?.message;
    expect(allowed).toContain("previewHosts option of createDecoWorker");
    const before = snapshotDir();
    foldSiteSettings(root, createReport());
    expect(snapshotDir()).toEqual(before);
  });

  it("without a site name, the note asks for it; a Next.js site is told the Deco hosts are new", () => {
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
    expect(note?.message).toContain('site: "<site>"');
    expect(note?.message).toContain("DECO_SITE_NAME wasn't found");

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
    const nextNote = next.manual.find((n) => n.subject === "preview hosts")?.message ?? "";
    expect(nextNote).toContain('pass site: "acme" to decideDraft and bindDraft');
    expect(nextNote).toContain("v7's Next.js binding didn't");
  });

  it("with no previewHosts on a named TanStack site, writes no list: the worker keeps v7's two hosts with no extra option", () => {
    site({
      "package.json": { name: "site", dependencies: { "@decocms/tanstack": "7.0.0" } },
      ".env": "DECO_SITE_NAME=acme\n",
      ".deco/blocks/pages-home.json": home,
    });
    const report = createReport();
    foldSiteSettings(root, report);
    expect(exists("CMS.json")).toBe(false);
    const note = report.manual.find((n) => n.subject === "preview hosts")?.message ?? "";
    expect(note).toContain('pass site: "acme" to createDecoWorker');
    expect(note).toContain("allows only those two, as v7 did");
    expect(note).not.toContain("previewHosts: []");
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

describe("v7's image URLs by 7.x release", () => {
  const deco = (v: string | undefined) => /decoCdn\(\{ ([^}]*) \}\)/.exec(v7ImageUrl(v))?.[1];

  it("gives the decoCdn options that reproduce each release's Image", () => {
    expect(deco("7.64.3")).toBe('domain, quality, sources: "all", legacyHosts: []');
    expect(v7ImageUrl("7.64.3")).toContain('else "decoims.com", the default before 7.71.0');
    expect(deco("7.71.0")).toBe('domain, quality, sources: "all", legacyHosts: []');
    expect(deco("7.71.3")).toBe('domain, quality, sources: "all", legacyHosts: []');
    expect(deco("7.71.4")).toBe(
      'domain, quality, sources: "all", stripAssetHosts: "leading", legacyHosts: ["decoims.com"]',
    );
    expect(deco("7.71.5")).toBe('domain, quality, sources: "all", stripAssetHosts: "leading"');
    expect(deco("7.80.0")).toBe('domain, quality, sources: "all", stripAssetHosts: "leading"');
    expect(v7ImageUrl("7.77.0")).not.toContain("Nuvemshop");
    expect(v7ImageUrl("7.77.1")).toContain("Nuvemshop");
    expect(v7ImageUrl(undefined)).toContain(
      "reference/framework-code.md lists the decoCdn options",
    );
    for (const v of ["7.2.0", "7.77.1", undefined]) {
      expect(v7ImageUrl(v)).toContain(
        "createImageUrl({ providers: [vtexCatalog(), shopifyCdn(), decoCdn(",
      );
    }
  });

  it("reads the site's 7.x version: installed copy first, else the package.json range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-version-"));
    try {
      expect(siteBlocksVersion(root)).toBeUndefined();
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@decocms/blocks": "^7.71.2" } }),
      );
      expect(siteBlocksVersion(root)).toBe("7.71.2");
      fs.mkdirSync(path.join(root, "node_modules", "@decocms", "blocks"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "node_modules", "@decocms", "blocks", "package.json"),
        JSON.stringify({ version: "7.77.4" }),
      );
      expect(siteBlocksVersion(root)).toBe("7.77.4");
      fs.writeFileSync(
        path.join(root, "node_modules", "@decocms", "blocks", "package.json"),
        JSON.stringify({ version: "8.3.0" }),
      );
      expect(siteBlocksVersion(root)).toBe("7.71.2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
