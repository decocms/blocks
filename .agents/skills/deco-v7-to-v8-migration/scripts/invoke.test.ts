// @vitest-environment node
/**
 * `/deco/invoke` → server functions, the loader-ctx and partial-section
 * stubs, v7's app blocks → client code, and the page setup, case by case.
 * bindings.test.ts runs them together on whole fixtures and type-checks the
 * result.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAppClients } from "./apps";
import { rewriteInvokes } from "./invoke";
import { createReport } from "./report";
import { writeScaffold } from "./scaffold";
import { rewriteLoaderContextIn, rewritePartialImports, writeStubs } from "./stubs";

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function site(files: Record<string, string | object>): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-to-v8-invoke-")));
  for (const [file, data] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === "string" ? data : JSON.stringify(data));
  }
  return root;
}
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file: string) => fs.existsSync(path.join(root, file));
const TANSTACK = { name: "site", dependencies: { "@decocms/tanstack": "7.77.1" } };
const NEXT = { name: "site", dependencies: { "@decocms/nextjs": "7.79.6" } };
const HANDLER =
  "export default async function (props: { id?: string }, req: Request) { return props; }\n";

describe("rewriteInvokes", () => {
  it("reads every v7 call shape: chains over lines, bracket keys, flat keys, invoke(key), Runtime.invoke", () => {
    site({
      "package.json": TANSTACK,
      "src/loaders/gateway/wishlist/add-item.ts": HANDLER,
      "src/loaders/can-spin.ts": HANDLER,
      "src/actions/cart/add.tsx": HANDLER,
      "src/runtime.ts":
        'export const invoke: any = null; // fetch("/deco/invoke/" + key)\nexport const Runtime = { invoke };\n',
      "src/a.ts": [
        'import { invoke } from "@decocms/blocks/sdk/invoke";',
        'import { Runtime } from "./runtime";',
        "export const run = async () => {",
        "  await invoke.site.loaders.gateway.wishlist",
        '    ["add-item"]({ id: "1" });',
        '  await invoke["site"].loaders["can-spin"]();',
        '  await invoke["site/actions/cart/add.ts"]({ id: "2" });',
        '  await invoke("/site/loaders/can-spin.ts", {});',
        '  await Runtime.invoke.site.actions.cart.add({ id: "3" });',
        "};",
        "",
      ].join("\n"),
    });
    const report = createReport();
    rewriteInvokes(root, report, new Map());
    const a = read("src/a.ts");
    expect(a).toContain('await $siteLoadersGatewayWishlistAddItem({ data: { id: "1" } });');
    expect(a).toContain("await $siteLoadersCanSpin();");
    expect(a).toContain('await $siteActionsCartAdd({ data: { id: "2" } });');
    expect(a).toContain("await $siteLoadersCanSpin({ data: {} });");
    expect(a).toContain('await $siteActionsCartAdd({ data: { id: "3" } });');
    expect(a).not.toMatch(/\binvoke(\[|\(|\.site)|Runtime|sdk\/invoke|\.\/runtime/);
    expect(a).toContain(
      'import { $siteActionsCartAdd, $siteLoadersCanSpin, $siteLoadersGatewayWishlistAddItem } from "./server/invoke.functions";',
    );
    const fns = read("src/server/invoke.functions.ts");
    expect(fns.match(/createServerFn/g)?.length).toBe(4); // the import and one per key
    expect(fns).toContain('import handler2 from "../actions/cart/add";');
    expect(exists("src/runtime.ts")).toBe(false);
  });

  it("writes Next.js server actions, called with the props", () => {
    site({
      "package.json": NEXT,
      "src/actions/newsletter.ts": HANDLER,
      "src/form.tsx": [
        '"use client";',
        'import { invoke } from "@decocms/blocks/sdk/invoke";',
        'export const send = () => invoke.site.actions.newsletter({ id: "x" });',
        "",
      ].join("\n"),
    });
    rewriteInvokes(root, createReport(), new Map());
    const form = read("src/form.tsx");
    expect(
      form.startsWith(
        '"use client";\nimport { $siteActionsNewsletter } from "./server/invoke.actions";',
      ),
    ).toBe(true);
    expect(form).toContain('$siteActionsNewsletter({ id: "x" })');
    const actions = read("src/server/invoke.actions.ts");
    expect(actions.startsWith('"use server";')).toBe(true);
    expect(actions).toContain(
      "export async function $siteActionsNewsletter(props?: Input<typeof handler0>) {",
    );
    expect(actions).toContain("return handler(props ?? {}, await invokeRequest());");
  });

  it("vendors an app's handler, stubs a key with none, and reports a computed key", () => {
    site({
      "package.json": TANSTACK,
      "node_modules/@decocms/apps-vtex/package.json": {
        name: "@decocms/apps-vtex",
        exports: { "./*": "./src/*.ts" },
      },
      "node_modules/@decocms/apps-vtex/src/loaders/cart.ts": HANDLER,
      "src/b.ts": [
        'import { invoke } from "@decocms/blocks/sdk/invoke";',
        "export const b = (name: string) => [",
        "  invoke.vtex.loaders.cart({}),",
        "  invoke.site.loaders.gone({}),",
        "  invoke.site.loaders[name]({}),",
        "];",
        "",
      ].join("\n"),
    });
    const report = createReport();
    const stubs = rewriteInvokes(root, report, new Map());
    const b = read("src/b.ts");
    expect(b).toContain("$vtexLoadersCart({ data: {} })");
    expect(read("src/server/invoke.functions.ts")).toContain('from "../vendor/vtex/loaders/cart";');
    expect(b).toContain('unportedInvoke("site/loaders/gone", {})');
    expect(stubs.has("unportedInvoke")).toBe(true);
    // The computed key stays, so its import does too.
    expect(b).toContain("invoke.site.loaders[name]({})");
    expect(b).toContain('import { invoke } from "@decocms/blocks/sdk/invoke";');
    expect(report.manual.some((n) => n.subject === "src/b.ts:5")).toBe(true);
    expect(report.manual.find((n) => n.subject.startsWith("site/loaders/gone"))?.message).toContain(
      "handler not found",
    );
  });

  it("leaves a site-local invoke tree of server functions alone", () => {
    site({
      "package.json": TANSTACK,
      "src/server/invoke.ts":
        'import { createServerFn } from "@tanstack/react-start";\nexport const invoke = { site: { loaders: { x: createServerFn() } } };\n',
      "src/c.ts":
        'import { invoke } from "~/server/invoke";\nexport const c = () => invoke.site.loaders.x({});\n',
    });
    rewriteInvokes(root, createReport(), new Map());
    expect(read("src/c.ts")).toContain("invoke.site.loaders.x({})");
    expect(exists("src/server/invoke.functions.ts")).toBe(false);
  });
});

describe("the loader-ctx and partial-section stubs", () => {
  it("rewrites ctx.invoke and app state in (props, req, ctx) loaders only", () => {
    site({ "package.json": TANSTACK });
    const text = [
      "export async function loader(props: { a: string }, req: Request, ctx: AppContext) {",
      "  const x = await ctx.invoke?.vtex?.loaders?.categories?.tree?.({ levels: 1 });",
      '  const y = ctx.getAppState("vtex");',
      "  const z = ctx.vtex.config;",
      "  return { x, y, z, device: ctx.device, h: ctx.response };",
      "}",
      "export const notALoader = (ctx: { data: number }) => ctx.data;",
      "export const onError = (_err: unknown, _input: unknown, ctx: { prev?: number }) => ctx.prev;",
      "",
    ].join("\n");
    const out = rewriteLoaderContextIn(path.join(root, "src/sections/A.tsx"), text, root);
    expect(out?.text).toContain(
      'await unportedInvoke("vtex/loaders/categories/tree", { levels: 1 })',
    );
    expect(out?.text).toContain('const y = appState("vtex");');
    expect(out?.text).toContain('const z = appState("vtex").config;');
    // The device step's and the report's.
    expect(out?.text).toContain("device: ctx.device, h: ctx.response");
    expect(out?.text).toContain("ctx.data;");
    // React Query's onError context isn't v7's ctx.
    expect(out?.text).toContain("=> ctx.prev;");
    expect(out?.text).toContain('import { appState, unportedInvoke } from "../migration-stubs";');
  });

  it("points useSection at a stub with v7 7.x's placeholder, and lists hx-* attributes", () => {
    site({
      "package.json": TANSTACK,
      "src/F.tsx":
        'import { useScript, useSection } from "@decocms/blocks/sdk";\nexport const F = () => <i hx-get={useSection()} data-s={useScript(() => 1)} />;\n',
    });
    const report = createReport();
    const used = rewritePartialImports(root, report);
    writeStubs(root, used, report);
    expect(read("src/F.tsx")).toContain(
      'import { useSection } from "./migration-stubs";\nimport { useScript } from "@decocms/blocks/sdk";',
    );
    expect(read("src/migration-stubs.ts")).toContain("@deprecated");
    expect(report.manual.find((n) => n.subject.startsWith("hx-*"))?.subject).toBe(
      "hx-* attributes (src/F.tsx)",
    );
  });
});

describe("writeAppClients", () => {
  it("writes each v7 app's client with v7's defaults, credentials by name only", () => {
    site({
      "package.json": TANSTACK,
      "node_modules/@decocms/apps-shopify/src/client.ts":
        'const u = "https://" + s + ".myshopify.com/api/2025-01/graphql.json";',
      ".deco/blocks/deco-shopify.json": {
        __resolveType: "site/apps/deco/shopify.ts",
        storeName: "acme",
        storefrontAccessToken: "public-token",
      },
      ".deco/blocks/deco-wake.json": { __resolveType: "site/apps/deco/wake.ts", account: "loja" },
      ".deco/blocks/deco-resend.json": {
        __resolveType: "site/apps/deco/resend.ts",
        apiKey: { __resolveType: "website/loaders/secret.ts", encrypted: "aa" },
        emailFrom: { name: "Shop" },
      },
      ".deco/blocks/deco-nuvemshop.json": { __resolveType: "site/apps/deco/nuvemshop.ts" },
      ".deco/blocks/deco-htmx.json": { __resolveType: "site/apps/deco/htmx.ts" },
    });
    const report = createReport();
    const handled = writeAppClients(root, report);
    const shopify = read("src/clients/shopify.ts");
    // A plain string v7 accepted as is stays; the API version the installed app spoke.
    expect(shopify).toContain('storefrontAccessToken: "public-token",');
    expect(shopify).toContain('apiVersion: "2025-01",');
    expect(read("src/clients/wake.ts")).toContain(
      'checkoutUrl: "https://loja.checkout.fbits.store",',
    );
    expect(read("src/clients/wake.ts")).toContain('storefrontToken: required("WAKE_TOKEN"),');
    const resend = read("src/clients/resend.ts");
    expect(resend).toContain('apiKey: required("RESEND_API_KEY"),');
    expect(resend).toContain('"emailFrom": "Shop <onboarding@resend.dev>"');
    expect(exists("src/clients/nuvemshop.ts")).toBe(false);
    expect(handled.has("site/apps/deco/htmx.ts")).toBe(true);
    expect(report.manual.find((n) => n.subject.includes("nuvemshop"))?.message).toContain(
      "no Nuvemshop client",
    );
  });
});

describe("writeScaffold", () => {
  const MAP = [
    "export interface BlockDescriptor { component: string; props: Record<string, any> }",
    "export function loadSections() {}",
    "export function matchPage() {}",
    "export default { x: (props: any) => matchers.random(props, matcherInput()) };",
    "",
  ].join("\n");

  it("keeps the site's own files and replaces v7's page routes", () => {
    site({
      "package.json": TANSTACK,
      ".deco/index.ts": MAP,
      "src/views.ts": "export const views = {};\n",
      "src/cms.ts": "export const mine = 1;\n",
      "src/routes/index.tsx": 'import { cmsHomeRouteConfig } from "@decocms/tanstack";\n',
      "src/routes/$.tsx": "export const Route = 'mine';\n",
      "src/routes/deco/meta.ts": 'import { decoMetaRoute } from "@decocms/tanstack/routes";\n',
    });
    const report = createReport();
    writeScaffold(root, report);
    expect(read("src/cms.ts")).toBe("export const mine = 1;\n");
    expect(read("src/routes/$.tsx")).toBe("export const Route = 'mine';\n");
    expect(read("src/routes/index.tsx")).toContain('createFileRoute("/")');
    expect(exists("src/routes/deco/meta.ts")).toBe(false);
    expect(read("src/open-page.server.ts")).toContain("commitSegmentCookie(request);");
    expect(report.manual.find((n) => n.subject.includes("src/cms.ts"))?.message).toContain("kept");
  });

  it("finds a Next.js catch-all in a route group and keeps its parameter", () => {
    site({
      "package.json": NEXT,
      ".deco/index.ts": MAP.replace("export function matchPage() {}\n", ""),
      "src/views.ts": "export const views = {};\n",
      "app/(cms)/[...path]/page.tsx": 'import { createDecoPage } from "@decocms/nextjs";\n',
    });
    writeScaffold(root, createReport());
    const page = read("app/(cms)/[...path]/page.tsx");
    expect(page).toContain("params: Promise<{ path?: string[] }>;");
    expect(page).toContain('import { cms } from "../../../src/cms";');
    expect(exists("src/app")).toBe(false);
  });
});
