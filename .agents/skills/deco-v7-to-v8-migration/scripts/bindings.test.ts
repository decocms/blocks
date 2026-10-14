// @vitest-environment node
/**
 * End to end on a v7 TanStack Start fixture: `migrate` points the imports the
 * v8 binding keeps (the router, the progress bar, the image components, the
 * server-function fetch) and the draft names at `@decocms/tanstack`, and the
 * result type-checks against this repository's `@decocms/tanstack` and
 * `@decocms/blocks`, with the image URLs the report tells the site to write
 * (the platform helpers from `@decocms/apps-vtex/image` and
 * `@decocms/apps-shopify/image`, the Deco CDN from `@decocms/blocks/image`).
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
const PKGS = ["blocks", "tanstack", "apps-vtex", "apps-shopify"];

/** `paths` onto each package's `source` files, so the check needs no build. */
function sourcePaths(): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const pkg of PKGS) {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGES, pkg, "package.json"), "utf8"));
    for (const [sub, target] of Object.entries<any>(manifest.exports)) {
      const source = target.source ?? target.workerd?.source;
      if (!source) continue;
      paths[`@decocms/${pkg}${sub === "." ? "" : sub.slice(1)}`] = [
        path.join(PACKAGES, pkg, source),
      ];
    }
  }
  return paths;
}

/** v7's image URLs, as the report spells them (domain and quality left out: the site registered none). */
const IMAGE_URL =
  'createImageUrl({ providers: [vtexCatalog(), shopifyCdn(), decoCdn({ sources: "all" })] })';

let root: string;
let report: Report;

function write(file: string, data: string | object) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
}

const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-to-v8-bindings-")));
  fs.mkdirSync(path.join(root, "node_modules", "@decocms"), { recursive: true });
  for (const pkg of PKGS) {
    fs.symlinkSync(
      path.join(PACKAGES, pkg),
      path.join(root, "node_modules", "@decocms", pkg),
      "dir",
    );
  }
  // What a TanStack site installs next to them.
  for (const dep of ["react", "@types/react", "@tanstack/react-router"]) {
    fs.mkdirSync(path.dirname(path.join(root, "node_modules", dep)), { recursive: true });
    fs.symlinkSync(
      path.join(REPO, "node_modules", dep),
      path.join(root, "node_modules", dep),
      "dir",
    );
  }
  write("package.json", {
    name: "v7-tanstack-site",
    private: true,
    type: "module",
    dependencies: { "@decocms/blocks": "7.64.3", "@decocms/tanstack": "7.64.3" },
  });
  write(".deco/blocks/pages-home.json", {
    __resolveType: "website/pages/Page.tsx",
    name: "Home",
    path: "/",
    sections: [],
  });
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
  report = await migrate({ root });
  // The manual step the report names for the image components, as a site writes it.
  write(
    "src/imageUrl.tsx",
    [
      'import { shopifyCdn } from "@decocms/apps-shopify/image";',
      'import { vtexCatalog } from "@decocms/apps-vtex/image";',
      'import { createImageUrl, decoCdn } from "@decocms/blocks/image";',
      'import { ImageUrlProvider } from "@decocms/tanstack/react";',
      'import type { ReactNode } from "react";',
      `export const imageUrl = ${IMAGE_URL};`,
      "export const Wrap = ({ children }: { children: ReactNode }) => (",
      "  <ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider>",
      ");",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("a v7 TanStack Start site on the v8 binding", () => {
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
    const image = report.manual.find((n) => n.subject === "Image, Picture, Source")?.message;
    expect(image).toContain("ImageUrlProvider");
    expect(image).toContain(
      'createImageUrl({ providers: [vtexCatalog(), shopifyCdn(), decoCdn({ domain, quality, sources: "all" })] })',
    );
    expect(image).toContain("vtexCatalog from @decocms/apps-vtex/image");
    expect(image).toContain("shopifyCdn from @decocms/apps-shopify/image");
    expect(read("src/draft.ts")).toContain(
      'import { DRAFT_COOKIE, STUDIO_ORIGINS } from "@decocms/tanstack";',
    );
    const deps = report.manual.find((n) => n.step === "scripts" && n.subject === "package.json");
    expect(deps?.message).toContain("@decocms/tanstack ^8.3.0");
  });

  it("type-checks against the v8 packages", () => {
    const files = [
      "src/router.tsx",
      "src/Shell.tsx",
      "src/start.ts",
      "src/Banner.tsx",
      "src/draft.ts",
      "src/imageUrl.tsx",
    ].map((f) => path.join(root, f));
    const program = ts.createProgram(files, {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      paths: sourcePaths(),
      jsx: ts.JsxEmit.ReactJSX,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: [],
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName.startsWith(path.join(root, "src")))
      .map((d) => {
        const where = d.file ? path.relative(root, d.file.fileName) : "";
        return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
      });
    expect(errors).toEqual([]);
  }, 60_000);
});
