// @vitest-environment node
/**
 * The codemods onto `@decocms/compat-v7`, one by one: the imports, `ctx.device`,
 * the section-loader registration, the matchers, the view
 * registry and the image URL wiring.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeBlockMap } from "./blockMap";
import {
  COMPAT_V7_ENTRIES,
  type ContextRead,
  compatCommerceSpecifier,
  rewriteDeviceReadsIn,
} from "./compat";
import { imageModule, writeImageUrl } from "./imageModule";
import { rewriteImports } from "./imports";
import { v7Matcher } from "./matchers";
import { createReport } from "./report";
import { wireSectionLoaders } from "./sectionLoaders";

const PACKAGE = path.resolve(__dirname, "../../../../packages/compat-v7");

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function site(files: Record<string, string | object>): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-to-v8-compat-")));
  for (const [file, data] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === "string" ? data : JSON.stringify(data));
  }
  return root;
}
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const TANSTACK = { name: "site", dependencies: { "@decocms/tanstack": "7.77.1" } };

describe("the codemod's list of @decocms/compat-v7 entry points", () => {
  it("is the package's exports", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    expect(
      Object.keys(manifest.exports).map((k) => `@decocms/compat-v7${k === "." ? "" : k.slice(1)}`),
    ).toEqual(COMPAT_V7_ENTRIES);
  });

  it("maps every v7 @decocms/apps-commerce pure file, and nothing of v7's app runtime", () => {
    for (const sub of [
      "types",
      "types/cart",
      "sdk/analytics",
      "sdk/formatPrice",
      "sdk/url",
      "sdk/useOffer",
      "sdk/useVariantPossibilities",
      "utils/canonical",
      "utils/constants",
      "utils/filters",
      "utils/productToAnalyticsItem",
      "utils/stateByZip",
    ]) {
      expect(compatCommerceSpecifier(`@decocms/apps-commerce/${sub}`)).toBe(
        `@decocms/compat-v7/commerce/${sub}`,
      );
    }
    expect(compatCommerceSpecifier("@decocms/apps-commerce/utils/filters.ts")).toBe(
      "@decocms/compat-v7/commerce/utils/filters",
    );
    // The 6.x path a 7.x site may still import: the same files.
    expect(compatCommerceSpecifier("@decocms/apps/commerce/types")).toBe(
      "@decocms/compat-v7/commerce/types",
    );
    for (const sub of ["app-types", "registry", "resolve", "manifest-utils", "sdk/nothing"]) {
      expect(compatCommerceSpecifier(`@decocms/apps-commerce/${sub}`)).toBeUndefined();
    }
  });
});

describe("imports onto @decocms/compat-v7", () => {
  it("rewrites commerce specifiers whole, any import form, and reports v7's app runtime", () => {
    site({
      "src/a.ts": [
        'import type { Product } from "@decocms/apps-commerce/types";',
        "import * as price from '@decocms/apps-commerce/sdk/formatPrice';",
        'export type { Cart } from "@decocms/apps-commerce/types/cart";',
        'type O = typeof import("@decocms/apps-commerce/sdk/useOffer");',
        'import { registry } from "@decocms/apps-commerce/registry";',
        "",
      ].join("\n"),
      // A vendored loader's own imports of commerce types move too.
      "src/vendor/shopify/loaders/ProductList.ts":
        'import type { Product } from "@decocms/apps-commerce/types";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(read("src/a.ts")).toBe(
      [
        'import type { Product } from "@decocms/compat-v7/commerce/types";',
        "import * as price from '@decocms/compat-v7/commerce/sdk/formatPrice';",
        'export type { Cart } from "@decocms/compat-v7/commerce/types/cart";',
        'type O = typeof import("@decocms/compat-v7/commerce/sdk/useOffer");',
        'import { registry } from "@decocms/apps-commerce/registry";',
        "",
      ].join("\n"),
    );
    expect(read("src/vendor/shopify/loaders/ProductList.ts")).toContain(
      "@decocms/compat-v7/commerce/types",
    );
    expect(report.manual.map((n) => n.subject)).toEqual([
      "@decocms/apps-commerce/registry {registry}",
    ]);
    expect(report.manual[0].message).toContain("v7's app runtime");
  });

  it("moves v7's helpers by name, splitting declarations, and leaves what has no port reported", () => {
    site({
      "src/a.tsx": [
        'import { clx, detectDevice, useScript, useSection, logger } from "@decocms/blocks/sdk";',
        'import type { SectionProps, AppContext, Resolved } from "@decocms/blocks/types";',
        'import type { ImageWidget as Img, Color } from "@decocms/blocks/types/widgets";',
        'import { type Flag, createCMS } from "@decocms/blocks";',
        'import { inlineScript } from "@decocms/blocks/sdk/useScript";',
        'import { isMobileUA, useDevice } from "@decocms/blocks/sdk/useDevice";',
        'import { compose, withMobile, registerLayoutSections } from "@decocms/blocks/cms";',
        "",
      ].join("\n"),
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(read("src/a.tsx")).toBe(
      [
        'import { clx } from "@decocms/compat-v7/clx";',
        'import { detectDevice } from "@decocms/compat-v7/device";',
        'import { useScript } from "@decocms/compat-v7/script";',
        'import { useSection, logger } from "@decocms/blocks/sdk";',
        'import type { SectionProps, Resolved } from "@decocms/compat-v7/types";',
        'import type { AppContext } from "@decocms/blocks/types";',
        'import type { ImageWidget as Img, Color } from "@decocms/compat-v7/types/widgets";',
        'import { type Flag } from "@decocms/compat-v7/types";',
        'import { createCMS } from "@decocms/blocks";',
        'import { inlineScript } from "@decocms/compat-v7/script";',
        'import { isMobileUA } from "@decocms/compat-v7/device";',
        'import { useDevice } from "@decocms/blocks/sdk/useDevice";',
        'import { compose, withMobile } from "@decocms/compat-v7/sections";',
        'import { registerLayoutSections } from "@decocms/blocks/cms";',
        "",
      ].join("\n"),
    );
    const notes = Object.fromEntries(report.manual.map((n) => [n.subject, n.message]));
    expect(notes["@decocms/blocks/sdk {useSection}"]).toContain("partial sections");
    expect(notes["@decocms/blocks/types {AppContext}"]).toContain("ctx and apps are gone");
    // Without a binding there's no device context to point at: reported with the way out.
    expect(notes["@decocms/blocks/sdk/useDevice {useDevice}"]).toContain("requestDevice()");
    expect(notes["@decocms/blocks/cms {registerLayoutSections}"]).toContain("nonCritical");
  });

  it("points useDevice at the binding's subpath and says how to seed it", () => {
    site({
      "package.json": TANSTACK,
      "src/a.tsx": 'import { useDevice, DeviceProvider } from "@decocms/blocks/sdk/useDevice";\n',
    });
    const report = createReport();
    rewriteImports(root, report, new Map());
    expect(read("src/a.tsx")).toBe(
      'import { useDevice, DeviceProvider } from "@decocms/compat-v7/tanstack";\n',
    );
    expect(report.manual.find((n) => n.subject === "useDevice")?.message).toContain(
      "requestDevice() from @decocms/compat-v7/tanstack/server",
    );
  });
});

describe("ctx.device", () => {
  const rewrite = (text: string, left: ContextRead[] = []) =>
    rewriteDeviceReadsIn("x.tsx", text, left);

  it("reads v7's device from the loader's request, importing detectDevice once", () => {
    const out = rewrite(
      [
        '"use client";',
        'import type { AppContext } from "../apps/site";',
        "export const loader = (props: P, req: Request, ctx: AppContext) => ({",
        "  ...props,",
        "  device: ctx.device,",
        '  isMobile: ["mobile", "tablet"].includes(ctx?.device),',
        "});",
        "export function other(props: P, _req: Request, context: unknown) {",
        "  return (context as any).device ?? context.device;",
        "}",
        "",
      ].join("\n"),
    );
    expect(out).toBe(
      [
        '"use client";',
        'import type { AppContext } from "../apps/site";',
        'import { detectDevice } from "@decocms/compat-v7/device";',
        "export const loader = (props: P, req: Request, ctx: AppContext) => ({",
        "  ...props,",
        '  device: detectDevice(req.headers.get("user-agent") ?? ""),',
        '  isMobile: ["mobile", "tablet"].includes(detectDevice(req.headers.get("user-agent") ?? "")),',
        "});",
        "export function other(props: P, _req: Request, context: unknown) {",
        '  return detectDevice(_req.headers.get("user-agent") ?? "") ?? detectDevice(_req.headers.get("user-agent") ?? "");',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("leaves a third argument that isn't v7's context, and a function with two", () => {
    const text = [
      "const pick = (a: A, b: B, options: { device: string }) => options.device;",
      "const two = (props: P, ctx: C) => ctx.device;",
      "",
    ].join("\n");
    expect(rewrite(text)).toBeUndefined();
  });

  it("reports the reads it leaves: ctx.device with no request parameter, and the rest of ctx", () => {
    const left: ContextRead[] = [];
    const text = [
      "export const loader = (p: P, { url }: Request, ctx: Ctx) => ctx.device;",
      "export const other = async (p: P, req: Request, ctx: AppContext) => ({",
      "  tree: await ctx.invoke?.vtex?.loaders?.tree(),",
      "  headers: (ctx as { response: R }).response,",
      '  vtex: ctx["vtex"],',
      "});",
      "",
    ].join("\n");
    expect(rewrite(text, left)).toBeUndefined();
    expect(left).toEqual([
      { line: 1, read: "device" },
      { line: 3, read: "invoke" },
      { line: 4, read: "response" },
      { line: 5, read: '"vtex"' },
    ]);
  });

  it("aliases a local detectDevice", () => {
    expect(
      rewrite(
        "function detectDevice() {}\nexport const loader = (p: P, req: Request, ctx: Ctx) => ctx.device;\n",
      ),
    ).toBe(
      'import { detectDevice as detectV7Device } from "@decocms/compat-v7/device";\nfunction detectDevice() {}\nexport const loader = (p: P, req: Request, ctx: Ctx) => detectV7Device(req.headers.get("user-agent") ?? "");\n',
    );
  });

  it("gives v7's own ctx.device: the user agent's class by v7's patterns", async () => {
    const { detectDevice } = await import("@decocms/compat-v7/device");
    const out = rewrite("export const loader = (p: {}, req: Request, ctx: Ctx) => ctx.device;\n")!;
    const expr = /=> (.*);\n$/.exec(out)?.[1] ?? "";
    const run = new Function("detectDevice", "req", `return ${expr};`);
    for (const ua of ["Mozilla/5.0 (iPad; CPU OS 17_0)", "Mozilla/5.0 (X11; Linux x86_64)", ""]) {
      const req = new Request("https://x.test/", { headers: ua ? { "user-agent": ua } : {} });
      // v7's buildSectionLoaderContext: detectDevice(req.headers?.get?.("user-agent") ?? "").
      expect(run(detectDevice, req)).toBe(detectDevice(req.headers.get("user-agent") ?? ""));
    }
  });
});

describe("section loaders", () => {
  it("reports a second registration, or one not at a module's top level, and converts none of them", () => {
    site({
      "src/a.ts":
        'import { registerSectionLoaders } from "@decocms/blocks/cms";\nregisterSectionLoaders({ a: (p) => p });\n',
      "src/b.ts":
        'import { registerSectionLoaders as reg } from "@decocms/blocks/cms";\nreg({ b: (p) => p });\nif (x) reg({});\n',
    });
    const report = createReport();
    const wiring = wireSectionLoaders(root, report);
    expect(wiring).toEqual({});
    expect(read("src/a.ts")).toContain("registerSectionLoaders({ a:");
    expect(report.manual.map((n) => n.subject)).toEqual(["src/b.ts:3", "registerSectionLoaders"]);
  });

  it("exports the map under any import name, keeps the other names, and reads its keys", () => {
    site({
      "src/setup.ts": [
        'import { registerSectionLoaders as reg, withDevice } from "@decocms/blocks/cms";',
        "const extra = {};",
        'reg({ "site/sections/A.tsx": withDevice(), ...extra });',
        "",
      ].join("\n"),
    });
    const report = createReport();
    const wiring = wireSectionLoaders(root, report);
    expect(wiring.loaders?.keys).toBeNull();
    expect(read("src/setup.ts")).toBe(
      [
        'import { withDevice } from "@decocms/blocks/cms";',
        'import type { RunSectionLoadersOptions } from "@decocms/compat-v7/sections";',
        "const extra = {};",
        'export const sectionLoaders: RunSectionLoadersOptions["loaders"] = { "site/sections/A.tsx": withDevice(), ...extra };',
        "",
      ].join("\n"),
    );
  });

  it("wires a section loader v7 never ran and lists it, the site's registered one winning", async () => {
    site({
      ".deco/blocks/Home.json": { __resolveType: "site/sections/A.tsx" },
      "src/sections/A.tsx":
        "export const loader = (p: { a: string }) => ({ ...p, by: 'module' });\nexport default function A() { return null; }\n",
      "src/sections/B.tsx":
        "export const loader = (p: { b: string }) => ({ ...p, by: 'module' });\nexport default function B() { return null; }\n",
      "src/sections/C.tsx": "export default function C() { return null; }\n",
      "src/setup.ts":
        'import { registerSectionLoaders } from "@decocms/blocks/cms";\nregisterSectionLoaders({ "site/sections/A.tsx": (p: { a: string }) => ({ ...p, by: "registered" }) });\n',
    });
    const report = createReport();
    writeBlockMap(root, report, wireSectionLoaders(root, report));
    const notes = report.manual.filter((n) => n.message.includes("loader"));
    expect(notes.map((n) => n.subject)).toEqual([
      "site/sections/B.tsx",
      "loadSections (.deco/index.ts)",
    ]);
    expect(notes[0].message).toContain("which v7 never did");
    expect(notes[0].message).toContain("approved difference (PO 2026-10-15)");
    const map = read(".deco/index.ts");
    expect(map).toContain('import { loader as bLoader } from "../src/sections/B";');
    expect(map).not.toContain("aLoader");
    expect(map).toContain('  "site/sections/B.tsx": own(bLoader),\n  ...sectionLoaders,\n};');
    // The latest 7.x by default: nested sections at any depth.
    expect(map).not.toContain("nested:");
    const { loadSections } = await importBlockMap();
    const run = await loadSections(
      [
        { component: "site/sections/A.tsx", props: { a: "1" } },
        { component: "site/sections/B.tsx", props: { b: "2" } },
        { component: "site/sections/C.tsx", props: { c: "3" } },
      ],
      new Request("https://shop.test/"),
    );
    expect(run.sections.map((s: { props: unknown }) => s.props)).toMatchObject([
      { a: "1", by: "registered" },
      { b: "2", by: "module" },
      { c: "3" },
    ]);
    expect(run.sections[2].props).toEqual({ c: "3" });
  });

  it("runs the sections' loaders when the site registered none", async () => {
    site({
      ".deco/blocks/Home.json": { __resolveType: "site/sections/B.tsx" },
      "src/sections/B.tsx":
        "export const loader = (p: { b: string }) => ({ ...p, by: 'module' });\nexport default function B() { return null; }\n",
    });
    const report = createReport();
    writeBlockMap(root, report, wireSectionLoaders(root, report));
    const map = read(".deco/index.ts");
    expect(map).not.toContain("sectionLoaders");
    expect(report.manual.map((n) => n.subject)).toContain("loadSections (.deco/index.ts)");
    const { loadSections } = await importBlockMap();
    const run = await loadSections(
      [{ component: "site/sections/B.tsx", props: { b: "2" } }],
      new Request("https://shop.test/"),
    );
    expect(run.sections[0].props).toMatchObject({ b: "2", by: "module" });
  });
});

/** The generated block map, imported with @decocms/compat-v7 linked into the site. */
async function importBlockMap() {
  fs.mkdirSync(path.join(root, "node_modules", "@decocms"), { recursive: true });
  fs.symlinkSync(
    fileURLToPath(new URL("../../../../packages/compat-v7", import.meta.url)),
    path.join(root, "node_modules", "@decocms", "compat-v7"),
    "dir",
  );
  return import(pathToFileURL(path.join(root, ".deco/index.ts")).href);
}

describe("matchers", () => {
  it("names the ported matchers, with or without .ts", () => {
    expect(v7Matcher("website/matchers/device.ts")).toBe("device");
    expect(v7Matcher("website/matchers/queryString")).toBe("queryString");
    expect(v7Matcher("website/matchers/posthog.ts")).toBeUndefined();
    expect(v7Matcher("site/matchers/device.ts")).toBeUndefined();
  });

  it("registers each one the content uses on a binding, and leaves environment and other sites to a person", () => {
    const content = {
      ".deco/blocks/Home.json": {
        __resolveType: "multivariate",
        variants: [
          { rule: { __resolveType: "website/matchers/host.ts", includes: "x" }, value: 1 },
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              op: "and",
              matchers: [{ __resolveType: "website/matchers/environment.ts" }],
            },
            value: 2,
          },
        ],
      },
    };
    site({ "package.json": TANSTACK, ...content });
    let report = createReport();
    writeBlockMap(root, report);
    const map = read(".deco/index.ts");
    expect(map).toContain('import * as matchers from "@decocms/compat-v7/matchers";');
    expect(map).toContain('import { matcherContext } from "@decocms/compat-v7/tanstack/server";');
    expect(map).toContain(
      '"website/matchers/host.ts": (props: matchers.HostProps) => matchers.host(props, matcherInput()),',
    );
    expect(map).toContain(
      '"website/matchers/multi.ts": (props: matchers.MultiProps) => matchers.multi(props),',
    );
    expect(map).not.toContain('"website/matchers/environment.ts"');
    expect(report.manual.map((n) => n.subject)).toContain(
      "website/matchers/environment.ts (in Home.json)",
    );

    fs.rmSync(root, { recursive: true, force: true });
    site(content);
    report = createReport();
    writeBlockMap(root, report);
    expect(read(".deco/index.ts")).not.toContain("compat-v7");
    expect(
      report.manual.find((n) => n.subject.startsWith("website/matchers/host.ts"))?.message,
    ).toContain("@decocms/compat-v7/matchers");
  });

  it("never registers v7's random matcher: the binding owns deco_segment", () => {
    site({
      "package.json": TANSTACK,
      ".deco/blocks/Home.json": {
        __resolveType: "website/pages/Page.tsx",
        path: "/",
        sections: [{ __resolveType: "website/matchers/random.ts", traffic: 0.5 }],
      },
    });
    const report = createReport();
    writeBlockMap(root, report);
    expect(read(".deco/index.ts")).not.toContain("matchers.random");
    expect(
      report.manual.find((n) => n.subject.startsWith("website/matchers/random.ts"))?.message,
    ).toContain("Experiments");
  });
});

describe("the view registry", () => {
  it("keeps a site's own src/views.ts", () => {
    site({
      ".deco/blocks/Home.json": { __resolveType: "site/sections/A.tsx" },
      "src/sections/A.tsx": "export default function A() { return null; }\n",
      "src/views.ts": "export const views = {};\n",
    });
    const report = createReport();
    writeBlockMap(root, report);
    expect(read("src/views.ts")).toBe("export const views = {};\n");
    expect(report.manual.find((n) => n.subject === "src/views.ts")?.message).toContain(
      "already exists",
    );
  });
});

describe("ImageUrlProvider in createDecoRouter", () => {
  const plan = imageModule("7.77.1", { copies: [], registered: {} });
  const wire = (router: string, file = "src/router.tsx") => {
    site({ [file]: router });
    const report = createReport();
    writeImageUrl(root, report, plan, "fallback");
    return { out: read(file), report };
  };

  it("wraps what an inline Wrap renders", () => {
    const { out } = wire(
      [
        'import { createDecoRouter } from "@decocms/tanstack/router";',
        "export const r = createDecoRouter({",
        "  routeTree,",
        "  Wrap: ({ children }) => (",
        "    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>",
        "  ),",
        "});",
        "",
      ].join("\n"),
    );
    expect(out).toBe(
      [
        'import { createDecoRouter } from "@decocms/tanstack/router";',
        'import { ImageUrlProvider } from "@decocms/tanstack/react";',
        'import { imageUrl } from "./imageUrl";',
        "export const r = createDecoRouter({",
        "  routeTree,",
        "  Wrap: ({ children }) => (",
        "    <QueryClientProvider client={queryClient}><ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider></QueryClientProvider>",
        "  ),",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("adds a Wrap to a multi-line call, after a trailing comma", () => {
    const { out } = wire(
      [
        'import { createDecoRouter } from "@decocms/tanstack/router";',
        "export const r = createDecoRouter({",
        "  routeTree,",
        '  defaultPreload: "intent",',
        "});",
        "",
      ].join("\n"),
    );
    expect(out).toContain(
      '  defaultPreload: "intent",\n  Wrap: ({ children }) => <ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider>,\n});',
    );
  });

  it("leaves a Wrap it can't read, and a .ts router, to a person", () => {
    const named = wire(
      'import { createDecoRouter } from "@decocms/tanstack/router";\nexport const r = createDecoRouter({ routeTree, Wrap });\n',
    );
    expect(named.out).not.toContain("ImageUrlProvider");
    expect(named.report.manual.map((n) => n.subject)).toContain("src/router.tsx");
    const plain = wire(
      'import { createDecoRouter } from "@decocms/tanstack/router";\nexport const r = createDecoRouter({ routeTree });\n',
      "src/router.ts",
    );
    expect(plain.out).not.toContain("ImageUrlProvider");
    expect(plain.report.manual.map((n) => n.subject)).toContain("src/router.ts");
  });

  it("keeps a site's own src/imageUrl.ts", () => {
    site({ "src/imageUrl.ts": "export const imageUrl = mine;\n" });
    const report = createReport();
    writeImageUrl(root, report, plan, "fallback");
    expect(read("src/imageUrl.ts")).toBe("export const imageUrl = mine;\n");
    expect(report.manual[0].message).toContain("already exists");
  });
});
