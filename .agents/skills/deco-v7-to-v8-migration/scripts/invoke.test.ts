// @vitest-environment node
/**
 * `/deco/invoke` → server functions, the loader-ctx and partial-section
 * stubs, v7's app blocks → client code, and the page setup, case by case.
 * bindings.test.ts runs them together on whole fixtures and type-checks the
 * result.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createVtexClient } from "@decocms/apps-vtex";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { writeAppClients } from "./apps";
import { rewriteInvokes, vtexInvokeMapKeysUsed } from "./invoke";
import { migrate } from "./migrate";
import { createReport } from "./report";
import { scopeQueryClient, v7RouteOptions, writeScaffold } from "./scaffold";
import { rewriteLoaderContextIn, rewritePartialImports, writeStubs } from "./stubs";
import { VtexInvokeChoiceNeeded } from "./vtexInvoke";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

/**
 * The generated `src/server/vtex-invoke.server.ts`, run: its framework import and the site's VTEX
 * client are replaced by the test's (the real v8 client over a fake fetch).
 */
async function importWith(
  dir: string,
  fakes: { getResponseHeaders: () => unknown; fetch: typeof fetch },
): Promise<any> {
  const text = fs
    .readFileSync(path.join(dir, "src/server/vtex-invoke.server.ts"), "utf8")
    .replace(
      /^import \{ getResponseHeaders \} from .*$/m,
      "const { getResponseHeaders } = globalThis.__vtexInvokeTest;",
    )
    .replace(
      /^import \{ vtexClient \} from .*$/m,
      "const { vtexClient } = globalThis.__vtexInvokeTest;",
    );
  (globalThis as Record<string, unknown>).__vtexInvokeTest = {
    getResponseHeaders: fakes.getResponseHeaders,
    vtexClient: () => createVtexClient({ account: "store", fetch: fakes.fetch, retry: false }),
  };
  const js = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = path.join(dir, "vtex-invoke.run.mjs");
  fs.writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

describe("VTEX invoke-map keys (--vtex-invoke)", () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const CHECKOUT = [
    'import { vtexFetch } from "../client";',
    "export async function addItemsToCart(props: { orderFormId: string; orderItems: unknown[] }) {",
    '  return vtexFetch("/api/checkout/pub/orderForm/" + props.orderFormId + "/items", props);',
    "}",
    "export async function simulateCart(props: { items: unknown[]; postalCode: string }) {",
    '  return vtexFetch("/api/checkout/pub/orderForms/simulation", props);',
    "}",
    "",
  ].join("\n");
  const v7Site = (pkg: object) =>
    site({
      "package.json": pkg,
      "node_modules/@decocms/apps-vtex/package.json": {
        name: "@decocms/apps-vtex",
        exports: { "./*": "./src/*.ts" },
      },
      "node_modules/@decocms/apps-vtex/src/client.ts":
        "export const vtexFetch = async (path: string, body: unknown) => ({ path, body });\n",
      "node_modules/@decocms/apps-vtex/src/actions/checkout.ts": CHECKOUT,
      "node_modules/@decocms/apps-vtex/src/actions/address.ts":
        "export async function deleteAddress(props: { id: string }) { return props; }\n",
      "src/clients/vtex.ts": [
        'import { createVtexClient, type VtexClient } from "@decocms/apps-vtex";',
        'export function vtexClient(): VtexClient { return createVtexClient({ account: "store", salesChannel: "1" }); }',
        "",
      ].join("\n"),
      "src/cart.ts": [
        'import { invoke } from "@decocms/blocks/sdk/invoke";',
        "export const cart = () => [",
        '  invoke.vtex.actions.checkout.addItemsToCart({ orderFormId: "of", orderItems: [] }),',
        '  invoke["vtex/actions/checkout/simulateCart.ts"]({ items: [], postalCode: "01000" }),',
        '  invoke.vtex.actions.address.deleteAddress({ id: "a" }),',
        "];",
        "",
      ].join("\n"),
    });

  /** Every file under the site and its bytes, to prove a run wrote nothing. */
  const tree = (dir: string): Record<string, string> =>
    Object.fromEntries(
      (fs.readdirSync(dir, { recursive: true }) as string[])
        .map((file) => path.join(dir, file))
        .filter((file) => fs.statSync(file).isFile())
        .map((file) => [path.relative(dir, file), fs.readFileSync(file, "utf8")]),
    );
  const KEYS = [
    "vtex/actions/address/deleteAddress",
    "vtex/actions/checkout/addItemsToCart",
    "vtex/actions/checkout/simulateCart",
  ];

  it("has no default: a site calling them without a choice stops before anything is written", async () => {
    v7Site(TANSTACK);
    const before = tree(root);
    expect(vtexInvokeMapKeysUsed(root)).toEqual(KEYS);
    const error = await migrate({ root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VtexInvokeChoiceNeeded);
    expect((error as VtexInvokeChoiceNeeded).keys).toEqual(KEYS);
    const message = (error as Error).message;
    for (const key of KEYS) expect(message).toContain(`  - ${key}\n`);
    expect(message).toContain("--vtex-invoke keep");
    expect(message).toContain("--vtex-invoke v8");
    expect(message).toContain("nothing was changed yet");
    expect(tree(root)).toEqual(before);
    // The step itself refuses to guess too.
    expect(() => rewriteInvokes(root, createReport(), new Map())).toThrow(VtexInvokeChoiceNeeded);
  });

  it("the command line stops with the keys and both choices, without the usage, and writes nothing", () => {
    v7Site(TANSTACK);
    const before = tree(root);
    const run = spawnSync("bun", [path.join(HERE, "main.ts"), "--root", root], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("3 VTEX keys that v7's VTEX app answered from its own invoke map");
    expect(run.stderr).toContain("  - vtex/actions/checkout/addItemsToCart");
    expect(run.stderr).toMatch(/--vtex-invoke keep {2}copy v7's handlers/);
    expect(run.stderr).toMatch(/--vtex-invoke v8 {4}no v7 code/);
    expect(run.stderr).not.toContain("Usage:");
    expect(tree(root)).toEqual(before);
  });

  it("a site that calls none of them needs no flag", () => {
    site({
      "package.json": TANSTACK,
      "src/loaders/thing.ts": "export default (props: { id: string }) => props;\n",
      "src/cart.ts": [
        'import { invoke } from "@decocms/blocks/sdk/invoke";',
        'export const thing = () => invoke["site/loaders/thing.ts"]({ id: "1" });',
        "",
      ].join("\n"),
    });
    expect(vtexInvokeMapKeysUsed(root)).toEqual([]);
    expect(() => rewriteInvokes(root, createReport(), new Map())).not.toThrow();
  });

  it("keep: each key calls v7's handler, vendored, by its export", () => {
    v7Site(TANSTACK);
    const report = createReport();
    const stubs = rewriteInvokes(root, report, new Map(), { vtexInvoke: "keep" });
    const fns = read("src/server/invoke.functions.ts");
    expect(fns).toContain(
      'import { addItemsToCart as handler0 } from "../vendor/vtex/actions/checkout";',
    );
    expect(fns).toContain(
      'import { deleteAddress as handler2 } from "../vendor/vtex/actions/address";',
    );
    expect(read("src/vendor/vtex/actions/checkout.ts")).toContain(
      "export async function simulateCart",
    );
    expect(read("src/cart.ts")).toContain(
      '$vtexActionsAddressDeleteAddress({ data: { id: "a" } })',
    );
    expect(stubs.size).toBe(0);
    expect(exists("src/server/vtex-invoke.server.ts")).toBe(false);
    expect(
      report.done.find((n) => n.subject === "VTEX invoke keys (--vtex-invoke keep)")?.message,
    ).toContain(
      "vtex/actions/checkout/addItemsToCart → src/vendor/vtex/actions/checkout.ts addItemsToCart",
    );
  });

  it("v8 on TanStack Start: the client's operations, a stub that rejects for the rest, no v7 code", async () => {
    v7Site(TANSTACK);
    const report = createReport();
    const stubs = rewriteInvokes(root, report, new Map(), { vtexInvoke: "v8" });
    expect(exists("src/vendor")).toBe(false);
    const fns = read("src/server/invoke.functions.ts");
    expect(fns).toContain('import { addItemsToCart as handler0 } from "./vtex-invoke.server";');
    expect(fns).toContain('import { simulateCart as handler1 } from "./vtex-invoke.server";');
    const v8 = read("src/server/vtex-invoke.server.ts");
    expect(v8).toContain(
      "return forward(vtex.checkout.addItems(props.orderFormId, props.orderItems.map((item) => ({ ...item, id: Number(item.id) })), shopper), request);",
    );
    expect(v8).toContain('import { vtexClient } from "../clients/vtex";');
    const cart = read("src/cart.ts");
    expect(cart).toContain('unportedVtexInvoke("vtex/actions/address/deleteAddress", { id: "a" })');
    expect(cart).toContain('import { unportedVtexInvoke } from "./migration-stubs";');
    expect([...stubs]).toEqual(["unportedVtexInvoke"]);
    const note = report.manual.find((n) =>
      n.subject.startsWith("vtex/actions/address/deleteAddress"),
    );
    expect(note?.message).toContain("--vtex-invoke v8");
    expect(note?.message).toContain("no operation for it");
    expect(
      report.manual.find((n) => n.subject.endsWith("(differences from v7)"))?.message,
    ).toContain("allowedOutdatedData");

    // The generated module and the server functions type-check against the v8 VTEX client.
    writeStubs(root, stubs, createReport());
    const links: [string, string][] = [
      ["node_modules/@tanstack", path.join(REPO, "node_modules", "@tanstack")],
    ];
    for (const [link, target] of links) fs.symlinkSync(target, path.join(root, link), "dir");
    const program = ts.createProgram(
      ["src/server/vtex-invoke.server.ts", "src/server/invoke.functions.ts", "src/cart.ts"].map(
        (f) => path.join(root, f),
      ),
      {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        types: [],
        paths: {
          "@decocms/apps-vtex": [path.join(REPO, "packages/apps-vtex/src/index.ts")],
          "@decocms/blocks/fetch": [path.join(REPO, "packages/blocks/src/v8/fetch.ts")],
          "@decocms/tanstack/server": [path.join(REPO, "packages/tanstack/src/server.ts")],
        },
      },
    );
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName.startsWith(path.join(root, "src")))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(errors).toEqual([]);

    // And the cart call forwards VTEX's cookies as v7 did: IS session cookies kept back, the site's domain.
    const appended: string[] = [];
    const { addItemsToCart } = await importWith(root, {
      getResponseHeaders: () => ({ append: (_: string, v: string) => appended.push(v) }),
      fetch: async () =>
        new Response(JSON.stringify({ orderFormId: "of" }), {
          headers: [
            [
              "set-cookie",
              "checkout.vtex.com=__ofid=of; Domain=store.vtexcommercestable.com.br; Path=/",
            ],
            ["set-cookie", "vtex_is_session=x; Path=/"],
          ],
        }),
    });
    const data = await addItemsToCart(
      { orderFormId: "of", orderItems: [] },
      new Request("https://shop.test/_serverFn/x", { headers: { cookie: "a=b" } }),
    );
    expect(data).toEqual({ orderFormId: "of" });
    expect(appended).toEqual(["checkout.vtex.com=__ofid=of; Domain=shop.test; Path=/"]);
  }, 60_000);

  it("v8 on Next.js: a call that returns VTEX's cookies isn't mapped (cookies() re-encodes them)", () => {
    v7Site(NEXT);
    const report = createReport();
    rewriteInvokes(root, report, new Map(), { vtexInvoke: "v8" });
    const v8 = read("src/server/vtex-invoke.server.ts");
    expect(v8).toContain("export async function simulateCart(");
    expect(v8).not.toContain("addItems");
    expect(v8).not.toContain("@tanstack");
    expect(read("src/cart.ts")).toContain(
      'unportedVtexInvoke("vtex/actions/checkout/addItemsToCart", { orderFormId: "of", orderItems: [] })',
    );
    expect(
      report.manual.find((n) => n.subject.startsWith("vtex/actions/checkout/addItemsToCart"))
        ?.message,
    ).toContain("route handler");
  });

  it("v8: an unmapped key's stub fails loudly when called, naming the key", async () => {
    site({});
    writeStubs(root, ["unportedVtexInvoke", "unportedInvoke"], createReport());
    const js = ts.transpileModule(read("src/migration-stubs.ts"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    fs.writeFileSync(path.join(root, "stubs.run.mjs"), js);
    const stubs = await import(pathToFileURL(path.join(root, "stubs.run.mjs")).href);
    await expect(
      stubs.unportedVtexInvoke("vtex/actions/address/deleteAddress", { id: "a" }),
    ).rejects.toThrow(/VTEX invoke vtex\/actions\/address\/deleteAddress isn't ported/);
    await expect(stubs.unportedInvoke("site/loaders/missing.ts")).rejects.toThrow(
      /invoke\(site\/loaders\/missing\.ts\) has no v8 equivalent/,
    );
  });

  it("the command line takes --vtex-invoke keep or v8 and refuses anything else", () => {
    const run = spawnSync("bun", [path.join(HERE, "main.ts"), "--vtex-invoke", "v7"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--vtex-invoke takes keep or v8, not "v7"');
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
    "export default { x: (props: any) => matchers.device(props, matcherInput()) };",
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
    expect(read("src/open-page.server.ts")).not.toContain("SegmentCookie");
    expect(report.manual.find((n) => n.subject.includes("src/cms.ts"))?.message).toContain("kept");
  });

  it("keeps what v7's routes passed cmsRouteConfig, and its search params, cache times and head", () => {
    site({
      "package.json": TANSTACK,
      ".deco/index.ts": `${MAP}export interface PageSeo { title?: string }\n`,
      "src/views.ts": "export const views = {};\n",
      ".deco/blocks/site.json": {
        __resolveType: "site/apps/site.ts",
        seo: { title: "Shop", titleTemplate: "%s | Shop", noIndexing: false, jsonLDs: [] },
      },
      "src/routes/$.tsx": [
        'import { cmsRouteConfig } from "@decocms/tanstack";',
        "const routeConfig = cmsRouteConfig({",
        '  siteName: "Shop",',
        '  defaultTitle: "Shop | Home",',
        '  ignoreSearchParams: ["skuId", "color"],',
        "  pendingMs: 60_000,",
        "  pendingMinMs: 0,",
        "});",
        "",
      ].join("\n"),
      "src/routes/index.tsx": [
        'import { cmsHomeRouteConfig } from "@decocms/tanstack";',
        'const baseConfig = cmsHomeRouteConfig({ defaultTitle: "Shop" });',
        "",
      ].join("\n"),
    });
    writeScaffold(root, createReport());
    const route = read("src/routes/$.tsx");
    expect(route).toContain('  siteName: "Shop",\n  defaultTitle: "Shop | Home",');
    expect(route).toContain('new Set(["skuId","color"])');
    expect(route).toContain("  pendingMs: 60_000,\n  pendingMinMs: 0,");
    expect(route).toContain("gcTime: DEV ? 30_000 : 300_000,");
    // v7's home route took no query unless the site added loaderDeps; its siteName defaulted to the title.
    const home = read("src/routes/index.tsx");
    expect(home).toContain(
      "loader: ({ location }) => loadPage({ data: { href: location.pathname } }),",
    );
    expect(home).not.toContain("loaderDeps");
    expect(home).toContain('  siteName: "Shop",\n  defaultTitle: "Shop",');
    expect(home).toContain("  pendingMs: 200,\n  pendingMinMs: 300,");
    expect(home).toContain("gcTime: DEV ? 30_000 : 1_800_000,");
    expect(read("src/page-view.tsx")).toContain(
      'import type { BlockDescriptor, PageSeo } from "../.deco";',
    );
    // v7 applied the saved site block's SEO to every page: defaults, then the page's template or the site's.
    const open = read("src/open-page.server.ts");
    expect(open).toContain(
      'const SITE_SEO: PageSeo = {\n  title: "Shop",\n  titleTemplate: "%s | Shop",\n};',
    );
    expect(open).toContain("template(props.titleTemplate) ?? template(SITE_SEO.titleTemplate)");
    expect(open).toContain('out.title = titleTemplate.replace("%s", out.title)');
  });

  it("reads a home route's loaderDeps as v7's query support", () => {
    expect(
      v7RouteOptions("cmsHomeRouteConfig({}); const r = { loaderDeps: () => ({}) };", "/").search,
    ).toBe(true);
    expect(v7RouteOptions("cmsRouteConfig({ siteName: `S`, pendingMs: x })", "/$")).toEqual({
      search: true,
      siteName: "S",
    });
  });

  it("moves a module-scope QueryClient into getRouter, and reports one used elsewhere", () => {
    site({
      "package.json": TANSTACK,
      "src/router.tsx": [
        'import { QueryClient } from "@tanstack/react-query";',
        "",
        "const queryClient = new QueryClient({",
        "  defaultOptions: { queries: { staleTime: 60_000 } },",
        "});",
        "",
        "export function getRouter() {",
        "  return createRouter({ context: { queryClient } });",
        "}",
        "",
      ].join("\n"),
    });
    const report = createReport();
    scopeQueryClient(root, report);
    expect(read("src/router.tsx")).toBe(
      [
        'import { QueryClient } from "@tanstack/react-query";',
        "",
        "export function getRouter() {",
        "  // One QueryClient per router: the server creates a router per request, so a visitor's data never",
        "  // reaches another visitor's render. The browser creates one router, so it keeps one client.",
        "  const queryClient = new QueryClient({",
        "    defaultOptions: { queries: { staleTime: 60_000 } },",
        "  });",
        "  return createRouter({ context: { queryClient } });",
        "}",
        "",
      ].join("\n"),
    );
    expect(report.done[0]?.message).toContain("one per request");

    fs.writeFileSync(
      path.join(root, "src/router.tsx"),
      "export const queryClient = new QueryClient();\nexport function getRouter() { return queryClient; }\n",
    );
    const second = createReport();
    scopeQueryClient(root, second);
    expect(read("src/router.tsx")).toContain("export const queryClient = new QueryClient();");
    expect(second.manual[0]?.message).toContain("shared by every request");
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
    // v7's metadata and section wrapper; the boundary is a client component.
    expect(page).toContain("alternates: seo.canonical ? { canonical: seo.canonical } : undefined,");
    expect(page).toContain(
      'import { SectionErrorBoundary } from "../../../src/section-error-boundary";',
    );
    expect(read("src/section-error-boundary.tsx").startsWith('"use client";')).toBe(true);
  });
});
