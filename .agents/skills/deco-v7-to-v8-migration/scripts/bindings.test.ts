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

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

/** v7 content both fixtures share: a page with an A/B test on a saved random matcher, and a device rule. */
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
        ],
      },
    ],
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
    report = await migrate({ root });
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
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
    expect(deps?.message).toContain("@decocms/tanstack ^8.3.0");
    expect(deps?.message).toContain("@decocms/compat-v7 ^8.3.0");
    expect(deps?.message).toContain("@decocms/apps-vtex ^8.3.0");
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
    expect(map).toContain(
      '"website/matchers/random.ts": (props: matchers.RandomProps) => matchers.random(props, matcherInput()),',
    );
    expect(map).toContain('import { sectionLoaders } from "../src/setup/section-loaders";');
    // 7.64.3 ran nested sections' loaders only directly in a prop.
    expect(map).toContain('nested: "direct",');
    // The saved random matcher keeps v7's cookie key: its saved name.
    expect(JSON.parse(read(".deco/blocks/Hero%20test.json"))).toEqual({
      __resolveType: "website/matchers/random.ts",
      traffic: 0.3,
      cohort: "Hero test",
    });
    expect(read("src/views.ts")).toContain('"site/sections/Hero.tsx": hero,');
    const matchersNote = report.manual.find((n) => n.subject === "v7 matchers (.deco/index.ts)");
    expect(matchersNote?.message).toContain("matchPage(href)");
    expect(matchersNote?.message).toContain("commitSegmentCookie()");
    expect(matchersNote?.message).toContain("cohortSegment(request)");
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
    root = makeSite("deco-v7-to-v8-next-", PKGS, ["react", "@types/react", "next"]);
    write("package.json", {
      name: "v7-next-site",
      private: true,
      type: "module",
      dependencies: { "@decocms/blocks": "7.79.6", "@decocms/nextjs": "7.79.6" },
    });
    writeContent(write);
    write("src/sections/Hero.tsx", HERO);
    write("src/setup/section-loaders.ts", SECTION_LOADERS);
    report = await migrate({ root });
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("registers v7's matchers over next/headers, and points useDevice at the Next.js subpath", () => {
    const map = read(".deco/index.ts");
    expect(map).toContain('import { matcherContext } from "@decocms/compat-v7/nextjs/server";');
    expect(map).toContain(
      '"website/matchers/random.ts": async (props: matchers.RandomProps) => matchers.random(props, await matcherContext()),',
    );
    expect(map).not.toContain("tanstack");
    // The latest 7.x walks nested sections at any depth: runSectionLoaders' default.
    expect(map).not.toContain("nested:");
    expect(read("src/sections/Hero.tsx")).toContain(
      'import { useDevice } from "@decocms/compat-v7/nextjs";',
    );
    const note = report.manual.find((n) => n.subject === "v7 matchers (.deco/index.ts)")?.message;
    expect(note).toContain("pageUrlRequestHeaders");
    expect(note).toContain("<SegmentCookie />");
    // Next.js images go through its image loader: no src/imageUrl.ts.
    expect(fs.existsSync(path.join(root, "src/imageUrl.ts"))).toBe(false);
  });

  it("type-checks against the v8 packages", () => {
    expect(typeErrors(root, PKGS)).toEqual([]);
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
