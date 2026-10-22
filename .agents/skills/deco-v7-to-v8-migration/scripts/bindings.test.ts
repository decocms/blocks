// @vitest-environment node
/**
 * End to end on a v7 TanStack Start fixture and a v7 Next.js one: `migrate`
 * points the imports the v8 binding keeps (the router, the progress bar, the
 * image components, the server-function fetch) and the draft names at the
 * binding, v7's helpers at `@decocms/compat-v7` (commerce, clx, scripts,
 * widgets, the device), writes the image URLs (`src/imageUrl.ts`, given to
 * every image through `createDecoRouter`'s `Wrap`), the view registry and a
 * block map that registers v7's matchers and runs v7's section loaders; and
 * the result type-checks against this repository's packages.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import type { Report } from "./report";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGES = path.join(REPO, "packages");

/** `paths` onto each package's `source` files, so the check needs no build. */
function sourcePaths(pkgs: string[]): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const pkg of pkgs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGES, pkg, "package.json"), "utf8"));
    for (const [sub, target] of Object.entries<any>(manifest.exports)) {
      const source = target.source ?? target.workerd?.source ?? target.default?.source;
      if (!source) continue;
      paths[`@decocms/${pkg}${sub === "." ? "" : sub.slice(1)}`] = [
        path.join(PACKAGES, pkg, source),
      ];
    }
  }
  return paths;
}

function makeSite(prefix: string, pkgs: string[], deps: string[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(dir, "node_modules", "@decocms"), { recursive: true });
  for (const pkg of pkgs) {
    fs.symlinkSync(
      path.join(PACKAGES, pkg),
      path.join(dir, "node_modules", "@decocms", pkg),
      "dir",
    );
  }
  for (const dep of deps) {
    fs.mkdirSync(path.dirname(path.join(dir, "node_modules", dep)), { recursive: true });
    fs.symlinkSync(
      path.join(REPO, "node_modules", dep),
      path.join(dir, "node_modules", dep),
      "dir",
    );
  }
  return dir;
}

function writer(dir: () => string) {
  return (file: string, data: string | object) => {
    const full = path.join(dir(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
  };
}

/** Type errors in the site's own files (src/ and .deco/), against the packages' sources. */
function typeErrors(dir: string, pkgs: string[]): string[] {
  const files = [
    ...fs
      .readdirSync(path.join(dir, "src"), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
      .map((d) => path.join(d.parentPath, d.name)),
    path.join(dir, ".deco", "index.ts"),
  ];
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    paths: sourcePaths(pkgs),
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (d) => d.file && !d.file.fileName.includes("node_modules") && d.file.fileName.startsWith(dir),
    )
    .map((d) => {
      const where = d.file ? path.relative(dir, d.file.fileName) : "";
      return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
}

/** A v7 storefront's worker entry: its segment, its CSP, the helpers they use, and what v8 drops. */
const V7_WORKER_ENTRY = [
  'import "./setup";',
  'import handler, { createServerEntry } from "@tanstack/react-start/server-entry";',
  'import { createDecoWorkerEntry } from "@decocms/tanstack";',
  'import { instrumentWorker } from "@decocms/blocks/sdk/otel";',
  'import { detectDevice } from "@decocms/blocks/sdk/useDevice";',
  'import { handleMeta, corsHeaders } from "@decocms/blocks-admin";',
  "",
  "const serverEntry = createServerEntry({ fetch: handler.fetch });",
  "",
  "const CSP_DIRECTIVES = [\"img-src 'self' data: https:\", \"connect-src 'self'\"];",
  "",
  "/** A cookie's value. */",
  "function readCookie(request: Request, name: string): string | undefined {",
  '  const match = (request.headers.get("cookie") ?? "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));',
  "  return match?.[1];",
  "}",
  "",
  "const decoWorker = createDecoWorkerEntry(serverEntry, {",
  "  observability: false,",
  "  admin: { handleMeta, corsHeaders },",
  "  csp: CSP_DIRECTIVES,",
  "  buildSegment: (request) => {",
  '    const device = detectDevice(request.headers.get("user-agent") ?? "") === "desktop" ? "desktop" : "mobile";',
  "    return {",
  "      device,",
  '      ...(readCookie(request, "customer_token") ? { loggedIn: true } : {}),',
  '      salesChannel: readCookie(request, "sc") ?? "1",',
  "    };",
  "  },",
  "  proxyHandler: async () => null,",
  "});",
  "",
  "export default instrumentWorker(decoWorker);",
  "",
].join("\n");

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

/** v7 content both fixtures share: a page with an A/B test on a saved random matcher, a device rule and a date rule. */
function writeContent(write: (file: string, data: string | object) => void) {
  write(".deco/blocks/Hero%20test.json", {
    __resolveType: "website/matchers/random.ts",
    traffic: 0.3,
  });
  write(".deco/blocks/pages-home.json", {
    __resolveType: "website/pages/Page.tsx",
    name: "Home",
    path: "/",
    sections: [
      {
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          {
            rule: { __resolveType: "Hero test" },
            value: [{ __resolveType: "site/sections/Hero.tsx", title: "B" }],
          },
          {
            rule: { __resolveType: "website/matchers/device.ts", mobile: true },
            value: [{ __resolveType: "site/sections/Hero.tsx", title: "Mobile" }],
          },
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2020-11-27T03:00:00.000Z",
              end: "2020-12-01T03:00:00.000Z",
            },
            value: [{ __resolveType: "site/sections/Hero.tsx", title: "Sale" }],
          },
        ],
      },
    ],
  });
}

/** v7 browser code and loaders that went through /deco/invoke, v7's loader ctx and its partial sections. */
function writeInvokeFixture(write: (file: string, data: string | object) => void) {
  // v7 templates' own proxy (src/runtime.ts): it fetched /deco/invoke.
  write(
    "src/runtime.ts",
    [
      "function proxy(path: string[] = []): any {",
      "  return new Proxy(async (props: unknown) => {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated source with a template literal
      '    const response = await fetch(`/deco/invoke/${path.join("/")}`, { method: "POST", body: JSON.stringify(props ?? {}) });',
      "    return response.json();",
      "  }, { get: (_t, prop: string) => proxy([...path, prop]) });",
      "}",
      "export const invoke = proxy() as any;",
      "export const Runtime = { invoke };",
      "",
    ].join("\n"),
  );
  write(
    "src/actions/notifyMe/subscribe.ts",
    [
      "export interface Props { skuId: string; email: string }",
      "export default async function subscribe(props: Props): Promise<{ success: boolean }> {",
      '  return { success: props.email.includes("@") };',
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/loaders/get-wishlist.ts",
    [
      "export default async function wishlist(_props: unknown, req: Request): Promise<string[]> {",
      '  return req.headers.get("cookie") ? ["a"] : [];',
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/components/OutOfStock.tsx",
    [
      'import { invoke } from "../runtime";',
      "export async function notify(email: string) {",
      "  const result = await invoke.site.actions.notifyMe.subscribe({",
      '    skuId: "1",',
      "    email,",
      "  });",
      "  return result.success;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/components/Wishlist.tsx",
    [
      'import { invoke } from "@decocms/blocks/sdk/invoke";',
      "export async function load() {",
      '  const items = await invoke["site"].loaders["get-wishlist"]();',
      '  await invoke("site/loaders/missing.ts", { id: 1 });',
      "  return items;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/sections/Search.tsx",
    [
      'import { useSection } from "@decocms/blocks/sdk";',
      "export interface Props { loader: { __resolveType: string }; title: string }",
      "export const loader = async (props: Props, req: Request, ctx: { invoke: any; account: string }) => {",
      "  const found = await ctx.invoke(props.loader.__resolveType, { q: new URL(req.url).search });",
      "  const tree = await ctx.invoke.vtex.loaders.categories.tree({ levels: 1 });",
      "  return { ...props, found, tree, account: ctx.account };",
      "};",
      "export default function Search(props: Props) {",
      "  return <input hx-post={useSection({ props })} placeholder={props.title} />;",
      "}",
      "",
    ].join("\n"),
  );
  write(".deco/blocks/deco-vtex.json", {
    __resolveType: "site/apps/deco/vtex.ts",
    account: "acme",
    appKey: { __resolveType: "website/loaders/secret.ts", encrypted: "00ff", name: "VTEX_APP_KEY" },
    publicUrl: "https://secure.acme.test",
    salesChannel: "",
  });
}

/** A v7 section with every helper compat-v7 carries, and a loader that reads ctx.device. */
const HERO = [
  'import { clx } from "@decocms/blocks/sdk/clx";',
  'import { useDevice } from "@decocms/blocks/sdk/useDevice";',
  'import { useScript } from "@decocms/blocks/sdk/useScript";',
  'import type { ImageWidget } from "@decocms/blocks/types/widgets";',
  'import type { SectionProps } from "@decocms/blocks/types";',
  'import { formatPrice } from "@decocms/apps-commerce/sdk/formatPrice";',
  'import type { Product } from "@decocms/apps-commerce/types";',
  "export interface Props { title: string; image?: ImageWidget; product?: Product }",
  'export function loader(props: Props, req: Request, ctx: { device: "mobile" | "tablet" | "desktop" }) {',
  "  return { ...props, device: ctx.device, url: req.url };",
  "}",
  "const onLoad = () => console.log(1);",
  "export default function Hero(props: SectionProps<typeof loader>) {",
  "  const device = useDevice();",
  "  return (",
  '    <div className={clx("hero", device === "mobile" && "small")}>',
  '      {props.title} {formatPrice(10, "BRL")} {props.device}',
  "      <script dangerouslySetInnerHTML={{ __html: useScript(onLoad) }} />",
  "    </div>",
  "  );",
  "}",
  "",
].join("\n");

const SECTION_LOADERS = [
  'import { registerSectionLoaders, withSectionLoader } from "@decocms/blocks/cms";',
  "registerSectionLoaders({",
  '  "site/sections/Hero.tsx": withSectionLoader(() => import("../sections/Hero")),',
  "});",
  "",
].join("\n");

describe("a v7 TanStack Start site on the v8 binding", () => {
  const PKGS = ["blocks", "tanstack", "compat-v7", "apps-vtex", "apps-shopify"];
  let root: string;
  let report: Report;
  const write = writer(() => root);
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

  beforeAll(async () => {
    root = makeSite("deco-v7-to-v8-bindings-", PKGS, [
      "react",
      "@types/react",
      "@tanstack/react-router",
      "@tanstack/react-start",
    ]);
    write("package.json", {
      name: "v7-tanstack-site",
      private: true,
      type: "module",
      dependencies: { "@decocms/blocks": "7.64.3", "@decocms/tanstack": "7.64.3" },
    });
    writeContent(write);
    write(
      "src/router.tsx",
      [
        'import { createDecoRouter } from "@decocms/tanstack";',
        'import type { AnyRoute } from "@tanstack/react-router";',
        "export const getRouter = (routeTree: AnyRoute) => createDecoRouter({ routeTree });",
        "",
      ].join("\n"),
    );
    write(
      "src/Shell.tsx",
      [
        'import { NavigationProgress, StableOutlet } from "@decocms/tanstack";',
        "export function Shell() {",
        "  return (<><NavigationProgress /><StableOutlet /></>);",
        "}",
        "",
      ].join("\n"),
    );
    write(
      "src/start.ts",
      [
        'import { decoServerFnFetch } from "@decocms/tanstack/sdk/serverFnFetch";',
        "export const serverFns = { fetch: decoServerFnFetch };",
        "",
      ].join("\n"),
    );
    write(
      "src/Banner.tsx",
      [
        'import { Image, Picture, Source, type ImageProps } from "@decocms/blocks/hooks";',
        'export function Banner({ src, alt }: { src: string; alt: ImageProps["alt"] }) {',
        "  return (",
        "    <Picture preload>",
        '      <Source media="(max-width: 767px)" src={src} width={320} height={280} />',
        '      <Image src={src} width={1280} height={280} alt={alt} fit="contain" />',
        "    </Picture>",
        "  );",
        "}",
        "",
      ].join("\n"),
    );
    write(
      "src/draft.ts",
      [
        'import { DRAFT_COOKIE, STUDIO_ORIGINS } from "@decocms/blocks";',
        "export const names = { cookie: DRAFT_COOKIE, origins: STUDIO_ORIGINS };",
        "",
      ].join("\n"),
    );
    write("src/sections/Hero.tsx", HERO);
    write("src/setup/section-loaders.ts", SECTION_LOADERS);
    writeInvokeFixture(write);
    write(
      "src/vite-env.d.ts",
      "interface ImportMeta {\n  readonly env: { readonly DEV: boolean };\n}\n",
    );
    write("wrangler.jsonc", {
      name: "acme",
      main: "./src/worker-entry.ts",
      vars: { DECO_SITE_NAME: "acme" },
    });
    write("src/worker-entry.ts", V7_WORKER_ENTRY);
    write(
      "src/types/cloudflare.d.ts",
      'declare module "cloudflare:workers" {\n  export const env: Record<string, unknown>;\n}\n',
    );
    write(
      "src/routes/__root.tsx",
      'import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute();\n',
    );
    write(
      "src/routes/$.tsx",
      [
        'import { createFileRoute } from "@tanstack/react-router";',
        'import { cmsRouteConfig, DecoPageRenderer } from "@decocms/tanstack";',
        'export const Route = createFileRoute("/$")({ ...cmsRouteConfig({ siteName: "x" }), component: DecoPageRenderer });',
        "",
      ].join("\n"),
    );
    write(
      "src/routes/deco/invoke.$.ts",
      [
        'import { createFileRoute } from "@tanstack/react-router";',
        'import { decoInvokeRoute } from "@decocms/tanstack/routes";',
        'export const Route = createFileRoute("/deco/invoke/$")(decoInvokeRoute);',
        "",
      ].join("\n"),
    );
    report = await migrate({ root });
    // What the site's own tooling generates before a type-check: the content module (deco content)
    // and the route tree (the router plugin).
    const { content } = await import("@decocms/blocks/cli");
    await content({ root, reporter: { info() {}, warn() {}, error() {} } as never });
    write(
      "src/routeTree.gen.ts",
      [
        'import { Route as rootRouteImport } from "./routes/__root";',
        'import { Route as SplatRouteImport } from "./routes/$";',
        'declare module "@tanstack/react-router" {',
        "  interface FileRoutesByPath {",
        '    "/$": { id: "/$"; path: "/$"; fullPath: "/$"; preLoaderRoute: typeof SplatRouteImport; parentRoute: typeof rootRouteImport };',
        "  }",
        "}",
        "export {};",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("turns each /deco/invoke key into a server function its call sites import", () => {
    const functions = read("src/server/invoke.functions.ts");
    expect(functions).toContain(
      'export const $siteActionsNotifyMeSubscribe = createServerFn({ method: "POST" })',
    );
    // A loader is a GET kept out of the shared cache.
    expect(functions).toContain(
      'export const $siteLoadersGetWishlist = createServerFn({ method: "GET" })',
    );
    expect(functions).toContain("markPrivate();");
    expect(functions).toContain('import handler0 from "../actions/notifyMe/subscribe";');
    const outOfStock = read("src/components/OutOfStock.tsx");
    expect(outOfStock).toContain(
      'import { $siteActionsNotifyMeSubscribe } from "../server/invoke.functions";',
    );
    expect(outOfStock).toContain("await $siteActionsNotifyMeSubscribe({ data: {");
    expect(outOfStock).not.toContain("../runtime");
    const wishlist = read("src/components/Wishlist.tsx");
    expect(wishlist).toContain("await $siteLoadersGetWishlist()");
    // No handler file: v7 failed too; the stub rejects.
    expect(wishlist).toContain('await unportedInvoke("site/loaders/missing", { id: 1 })');
    expect(wishlist).not.toContain("@decocms/blocks/sdk/invoke");
    // v7's proxy module: nothing imports it any more.
    expect(fs.existsSync(path.join(root, "src/runtime.ts"))).toBe(false);
  });

  it("stubs ctx.invoke, app state and useSection, keeping v7's placeholder URL", () => {
    const search = read("src/sections/Search.tsx");
    expect(search).toContain(
      "const found = await unportedInvoke(props.loader.__resolveType, { q: new URL(req.url).search });",
    );
    expect(search).toContain(
      'const tree = await unportedInvoke("vtex/loaders/categories/tree", { levels: 1 });',
    );
    expect(search).toContain('account: appState("account")');
    expect(search).toContain('import { useSection } from "../migration-stubs";');
    const stubs = read("src/migration-stubs.ts");
    expect(stubs).toContain('return "/__deco_legacy_htmx_section__";');
    expect(stubs).toContain("export function unportedInvoke(");
    expect(stubs).toContain("export function appState(");
    expect(report.manual.some((n) => n.subject.startsWith("hx-* attributes"))).toBe(true);
  });

  it("writes the VTEX client from v7's app block, credentials from v7's variables", () => {
    const vtex = read("src/clients/vtex.ts");
    expect(vtex).toContain('account: "acme",');
    // v7: block.salesChannel || "1".
    expect(vtex).toContain('salesChannel: "1",');
    expect(vtex).toContain('appKey: variable("VTEX_APP_KEY"),');
    expect(vtex).not.toContain("00ff");
    expect(vtex).toContain('"publicUrl": "https://secure.acme.test"');
    const note = report.manual.find((n) => n.step === "apps");
    expect(note?.message).toContain("set VTEX_APP_KEY, VTEX_APP_TOKEN");
    expect(report.manual.some((n) => n.subject.startsWith("site/apps/deco/vtex.ts"))).toBe(false);
  });

  it("writes the worker entry: the site's own page cache, with v7's segment and CSP", () => {
    const entry = read("src/worker-entry.ts");
    expect(entry).toContain("pageCache,");
    expect(entry).not.toContain("site:");
    expect(entry).toContain("csp: { reportOnly: CSP_DIRECTIVES },");
    expect(entry).toContain("const CSP_DIRECTIVES = [");
    expect(entry).toContain("function readCookie(request: Request, name: string)");
    expect(entry).toContain('salesChannel: readCookie(request, "sc") ?? "1",');
    expect(entry).not.toContain("createDecoWorkerEntry");
    expect(entry).not.toContain("instrumentWorker");
    expect(entry).not.toContain("@decocms/blocks/sdk/useDevice");
    expect(read("src/build-hash.d.ts")).toContain("declare const __BUILD_HASH__: string;");
    const left = report.manual.find(
      (n) =>
        n.subject === "src/worker-entry.ts" &&
        n.message.startsWith("v7's createDecoWorkerEntry options"),
    );
    expect(left?.message).toContain("not carried: proxyHandler.");
  });

  it("writes the page setup: the CMS, a page server function on the page's URL, the catch-all route", () => {
    expect(read("src/cms.ts")).toContain("contentClient(cms, request)");
    const open = read("src/open-page.server.ts");
    expect(open).toContain("const url = new URL(href, request.url);");
    expect(open).toContain("matchPage(url, request);");
    expect(open).toContain(
      "const { sections, degraded } = await loadSections(resolved.flat(), request, url);",
    );
    expect(open).not.toContain("SegmentCookie");
    expect(open).toContain("device: requestDevice(request)");
    expect(read("src/page.functions.ts")).toContain(
      ".handler(({ data }) => openPage(data.href, getRequest()));",
    );
    const view = read("src/page-view.tsx");
    expect(view).toContain("<DeviceProvider value={page.device}>");
    // v7's wrapper around each section, and its head.
    expect(view).toContain("data-manifest-key={section.component}");
    expect(view).toContain("<SectionErrorBoundary sectionKey={section.component}>");
    expect(view).toContain('meta.push({ property: "og:title", content: title });');
    expect(read("src/section-error-boundary.tsx")).toContain(
      'return <div data-section-error={sectionKey} className="hidden" />;',
    );
    // v7's catch-all is replaced, keeping what it passed cmsRouteConfig; its admin route is gone.
    const route = read("src/routes/$.tsx");
    expect(route).toContain("return loadPage({ data: { href: location.pathname + query } });");
    expect(route).toContain('siteName: "x",');
    expect(route).toContain('const IGNORED_SEARCH_PARAMS = new Set(["skuId"]);');
    expect(route).toContain("head: ({ loaderData }) => pageHead(loaderData, SITE),");
    expect(route).not.toContain("cmsRouteConfig(");
    expect(fs.existsSync(path.join(root, "src/routes/deco/invoke.$.ts"))).toBe(false);
  });

  it("points the kept imports at @decocms/tanstack", () => {
    expect(read("src/router.tsx")).toContain(
      'import { createDecoRouter } from "@decocms/tanstack/router";',
    );
    expect(read("src/Shell.tsx")).toContain(
      'import { NavigationProgress, StableOutlet } from "@decocms/tanstack/react";',
    );
    expect(read("src/start.ts")).toContain(
      'import { decoServerFnFetch } from "@decocms/tanstack/start";',
    );
    expect(read("src/Banner.tsx")).toContain(
      'import { Image, Picture, Source, type ImageProps } from "@decocms/tanstack/react";',
    );
    expect(read("src/draft.ts")).toContain(
      'import { DRAFT_COOKIE, STUDIO_ORIGINS } from "@decocms/tanstack";',
    );
    const deps = report.manual.find((n) => n.step === "scripts" && n.subject === "package.json");
    expect(deps?.message).toContain("@decocms/tanstack ^8.4.0");
    expect(deps?.message).toContain("@decocms/compat-v7 ^8.4.0");
    expect(deps?.message).toContain("@decocms/apps-vtex ^8.4.0");
  });

  it("writes v7 7.64.3's image URLs and gives them to every image through createDecoRouter's Wrap", () => {
    // No domain registered: 7.x's default before 7.71.0, decoims.com; no quality.
    expect(read("src/imageUrl.ts")).toContain(
      'providers: [vtexCatalog(), shopifyCdn(), decoCdn({ domain: "decoims.com", sources: "all" })]',
    );
    expect(read("src/router.tsx")).toContain(
      "createDecoRouter({ routeTree, Wrap: ({ children }) => <ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider> })",
    );
    expect(read("src/router.tsx")).toContain('import { imageUrl } from "./imageUrl";');
    expect(report.manual.some((n) => /ImageUrlProvider|Image, Picture/.test(n.subject))).toBe(
      false,
    );
  });

  it("points v7's helpers at @decocms/compat-v7, and reads ctx.device from the loader's request", () => {
    const hero = read("src/sections/Hero.tsx");
    for (const line of [
      'import { clx } from "@decocms/compat-v7/clx";',
      'import { useDevice } from "@decocms/compat-v7/tanstack";',
      'import { useScript } from "@decocms/compat-v7/script";',
      'import type { ImageWidget } from "@decocms/compat-v7/types/widgets";',
      'import type { SectionProps } from "@decocms/compat-v7/types";',
      'import { formatPrice } from "@decocms/compat-v7/commerce/sdk/formatPrice";',
      'import type { Product } from "@decocms/compat-v7/commerce/types";',
      'import { detectDevice } from "@decocms/compat-v7/device";',
      'device: detectDevice(req.headers.get("user-agent") ?? "")',
    ]) {
      expect(hero).toContain(line);
    }
    expect(hero).not.toContain("ctx.device");
    // useDevice needs the server's device: the report says how to seed it.
    expect(report.manual.find((n) => n.subject === "useDevice")?.message).toContain(
      "<DeviceProvider value={device}> from @decocms/compat-v7/tanstack",
    );
  });

  it("registers v7's matchers and runs v7's section loaders from the block map", () => {
    const map = read(".deco/index.ts");
    expect(map).toContain(
      '"website/matchers/device.ts": (props: matchers.DeviceProps) => matchers.device(props, matcherInput()),',
    );
    // v7's random matcher is never registered: the binding owns deco_segment.
    expect(map).not.toContain("matchers.random");
    expect(map).toContain('import { sectionLoaders } from "../src/setup/section-loaders";');
    // 7.64.3 ran nested sections' loaders only directly in a prop.
    expect(map).toContain('nested: "direct",');
    // The A/B test and the date window stay as they were: the report says to move them.
    expect(fs.existsSync(path.join(root, ".deco/blocks/Hero%20test.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".deco/blocks/experiments.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".deco/blocks/campaigns.json"))).toBe(false);
    expect(report.manual.find((n) => n.subject === "A/B tests")?.message).toContain(
      "#run-an-a-b-test",
    );
    expect(report.manual.find((n) => n.subject === "date rules")?.message).toContain(
      "#schedule-a-campaign",
    );
    expect(read("src/views.ts")).toContain('"site/sections/Hero.tsx": hero,');
    const matchersNote = report.manual.find((n) => n.subject === "v7 matchers (.deco/index.ts)");
    expect(matchersNote?.message).toContain("matchPage(href)");
    expect(matchersNote?.message).not.toContain("SegmentCookie");
    // The worker reads the visitor: nothing to wire by hand.
    expect(report.manual.some((n) => n.subject === "experiments")).toBe(false);
  });

  it("type-checks against the v8 packages", () => {
    expect(typeErrors(root, PKGS)).toEqual([]);
  }, 120_000);
});

describe("a v7 Next.js site on the v8 binding", () => {
  const PKGS = ["blocks", "nextjs", "compat-v7"];
  let root: string;
  let report: Report;
  const write = writer(() => root);
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

  beforeAll(async () => {
    root = makeSite(
      "deco-v7-to-v8-next-",
      [...PKGS, "apps-vtex"],
      ["react", "@types/react", "next"],
    );
    write("package.json", {
      name: "v7-next-site",
      private: true,
      type: "module",
      dependencies: { "@decocms/blocks": "7.79.6", "@decocms/nextjs": "7.79.6" },
    });
    writeContent(write);
    write("src/sections/Hero.tsx", HERO);
    write("src/setup/section-loaders.ts", SECTION_LOADERS);
    writeInvokeFixture(write);
    write("src/env.d.ts", "declare const process: { env: Record<string, string | undefined> };\n");
    write(
      "src/app/[[...slug]]/page.tsx",
      [
        'import { createDecoPage } from "@decocms/nextjs";',
        'const page = createDecoPage({ siteName: "x" });',
        "export const generateMetadata = page.generateMetadata;",
        "export default page.default;",
        "",
      ].join("\n"),
    );
    write(
      "src/app/deco/[[...deco]]/route.ts",
      [
        'import { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";',
        "export const { GET, POST } = createDecoRouteHandlers({});",
        "",
      ].join("\n"),
    );
    report = await migrate({ root });
    const { content } = await import("@decocms/blocks/cli");
    await content({ root, reporter: { info() {}, warn() {}, error() {} } as never });
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("turns each /deco/invoke key into a server action, and writes the page setup", () => {
    const actions = read("src/server/invoke.actions.ts");
    expect(actions.startsWith('"use server";')).toBe(true);
    expect(actions).toContain("export async function $siteActionsNotifyMeSubscribe(");
    expect(read("src/components/OutOfStock.tsx")).toContain(
      "await $siteActionsNotifyMeSubscribe({",
    );
    expect(read("src/clients/vtex.ts")).toContain("process.env[name]");
    expect(read("src/cms.ts")).toContain("contentClient(cms)");
    const page = read("src/app/[[...slug]]/page.tsx");
    expect(page).toContain("await bindDraft(cms, { searchParams: query });");
    expect(page).not.toContain("SegmentCookie");
    expect(page).not.toContain("createDecoPage");
    expect(read("src/open-page.server.ts")).toContain(
      "await loadSections(resolved.flat(), request, url)",
    );
    expect(fs.existsSync(path.join(root, "src/app/deco/[[...deco]]/route.ts"))).toBe(false);
  });

  it("registers v7's matchers over next/headers, and points useDevice at the Next.js subpath", () => {
    const map = read(".deco/index.ts");
    expect(map).toContain('import { matcherContext } from "@decocms/compat-v7/nextjs/server";');
    expect(map).toContain(
      '"website/matchers/device.ts": async (props: matchers.DeviceProps) => matchers.device(props, await matcherContext()),',
    );
    expect(map).not.toContain("matchers.random");
    expect(map).not.toContain("tanstack");
    // The latest 7.x walks nested sections at any depth: runSectionLoaders' default.
    expect(map).not.toContain("nested:");
    expect(read("src/sections/Hero.tsx")).toContain(
      'import { useDevice } from "@decocms/compat-v7/nextjs";',
    );
    const note = report.manual.find((n) => n.subject === "v7 matchers (.deco/index.ts)")?.message;
    expect(note).toContain("pageUrlRequestHeaders");
    expect(note).not.toContain("SegmentCookie");
    // The proxy reads the visitor: the report says how.
    expect(report.manual.find((n) => n.subject === "experiments")?.message).toContain("draftProxy");
    // The A/B test and the date window stay as they were, reported.
    expect(
      JSON.parse(read(".deco/blocks/pages-home.json")).sections[0].variants.map(
        (v: { rule: { __resolveType: string } }) => v.rule.__resolveType,
      ),
    ).toEqual(["Hero test", "website/matchers/device.ts", "date"]);
    expect(report.manual.some((n) => n.subject === "A/B tests")).toBe(true);
    expect(report.manual.some((n) => n.subject === "date rules")).toBe(true);
    // Next.js images go through its image loader: no src/imageUrl.ts.
    expect(fs.existsSync(path.join(root, "src/imageUrl.ts"))).toBe(false);
  });

  it("type-checks against the v8 packages", () => {
    expect(typeErrors(root, [...PKGS, "apps-vtex"])).toEqual([]);
  }, 120_000);
});

describe("the generated block map at runtime", () => {
  it("is a v8 block map whose matcher reads the request the page passes", async () => {
    // The device matcher as the Next.js block map writes it, with the request a proxy forwarded.
    const matchers = await import("@decocms/compat-v7/matchers");
    const request = new Request("https://shop.test/", { headers: { "user-agent": IPHONE } });
    expect(matchers.device({ mobile: true }, request)).toBe(true);
    expect(matchers.device({ desktop: true }, request)).toBe(false);
  });
});
