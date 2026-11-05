// @vitest-environment node
/**
 * Conformance: the CLI and example claims of the guide pages (quickstart,
 * how-it-works, nextjs, tanstack-start-descriptors, tanstack-start-rsc,
 * renames-and-migrations, troubleshooting, internals, design-decisions).
 *
 * Every command runs the real bin (`node bin/deco.js`) in a temp project that
 * imports `@decocms/blocks` like an app, and examples run with `tsx` or go
 * through `tsc` as written in the docs. The content module (content without
 * a site) is written by `content()` from the compiled `@decocms/blocks/cli`:
 * there is no `deco content` command any more.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFolderCdn } from "../cli/__tests__/fixture";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, "../../..");
const REPO = path.resolve(PACKAGE, "../..");
const NODE_MODULES = path.join(REPO, "node_modules");
const BIN = path.join(PACKAGE, "bin/deco.js");
const CLI = pathToFileURL(path.join(PACKAGE, "dist/v8/cli/index.js")).href;
const TSX = path.join(NODE_MODULES, ".bin/tsx");
const TSC = path.join(NODE_MODULES, ".bin/tsc");
const T = 120_000;

interface Project {
  root: string;
  write(file: string, content: string | object): void;
  read(file: string): string;
  exists(file: string): boolean;
  deco(...args: string[]): { code: number; out: string };
  /** Writes `.deco/blocks.gen.ts` with `content()`, from this folder or `root`. */
  module(root?: string): { code: number; out: string };
  run(cmd: string, args: string[], env?: Record<string, string>): { code: number; out: string };
}

const projects: Project[] = [];
let cdn: Awaited<ReturnType<typeof startFolderCdn>>;
beforeAll(async () => {
  cdn = await startFolderCdn();
});
afterAll(() => cdn.close());
afterEach(() => {
  for (const p of projects.splice(0)) fs.rmSync(p.root, { recursive: true, force: true });
});

function project(files: Record<string, string | object> = {}, withDeco = true): Project {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-conf-")));
  fs.symlinkSync(NODE_MODULES, path.join(root, "node_modules"), "dir");
  const p: Project = {
    root,
    write(file, content) {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(
        full,
        typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      );
    },
    read: (file) => fs.readFileSync(path.join(root, file), "utf8"),
    exists: (file) => fs.existsSync(path.join(root, file)),
    // deco check reads production from the CDN: here, this project's own blocks.
    deco: (...args) =>
      p.run(process.execPath, [BIN, ...args], args[0] === "check" ? cdn.envFor(root) : {}),
    module: (contentRoot) =>
      p.run(process.execPath, [
        "--input-type=module",
        "-e",
        `const { content } = await import(${JSON.stringify(CLI)}); process.exitCode = await content(${contentRoot ? JSON.stringify({ root: contentRoot }) : ""});`,
      ]),
    run(cmd, args, env = {}) {
      const r = spawnSync(cmd, args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", ...env },
      });
      return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
    },
  };
  projects.push(p);
  p.write("package.json", { name: "app", private: true, type: "module" });
  if (withDeco) fs.mkdirSync(path.join(root, ".deco/blocks"), { recursive: true });
  for (const [file, content] of Object.entries(files)) p.write(file, content);
  return p;
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  include: ["**/*.ts", "**/*.tsx", ".deco/**/*.ts", ".deco/**/*.tsx"],
  exclude: ["node_modules"],
};

// --- the quickstart, verbatim ------------------------------------------------

const EXPERIMENTS_TS = `export interface Experiments {
  /**
   * @title New checkout flow
   * @minimum 0
   * @maximum 100
   */
  newCheckout: number;
  /**
   * @title Sticky header
   * @minimum 0
   * @maximum 100
   */
  stickyHeader: number;
  /**
   * @title Free shipping banner
   * @minimum 0
   * @maximum 100
   */
  freeShippingBanner: number;
}

const roll = (percent: number) => Math.random() * 100 < percent;

export default function experiments(input: Experiments) {
  return {
    newCheckout: roll(input.newCheckout),
    stickyHeader: roll(input.stickyHeader),
    freeShippingBanner: roll(input.freeShippingBanner),
  };
}
`;
const QS_INDEX = `import type { Blocks } from "@decocms/blocks";
import experiments from "../experiments";

export default { experiments } satisfies Blocks;
`;
const QS_CMS = `import { createCMS } from "@decocms/blocks";
import blocks from "./.deco";
import content from "./.deco/blocks.gen";

export const cms = createCMS({ blocks, content });
`;
const QS_CHECKOUT = `import { cms } from "./cms";
import type experiments from "./experiments";

const client = cms.forRelease();
const [flags, error] = await client.resolve<ReturnType<typeof experiments>>("Experiments");
if (error) throw error;
console.log(JSON.stringify(flags));
`;
const experimentsJson = (newCheckout: number) => ({
  __resolveType: "experiments",
  newCheckout,
  stickyHeader: 50,
  freeShippingBanner: 0,
});

function quickstart(): Project {
  return project({
    "experiments.ts": EXPERIMENTS_TS,
    ".deco/index.ts": QS_INDEX,
    "cms.ts": QS_CMS,
    "checkout.ts": QS_CHECKOUT,
    ".deco/blocks/Experiments.json": experimentsJson(10),
    "tsconfig.json": TSCONFIG,
  });
}

/** Every object anywhere in a JSON value. */
function objects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) objects(v, out);
  else if (value && typeof value === "object") {
    out.push(value as Record<string, unknown>);
    for (const v of Object.values(value)) objects(v, out);
  }
  return out;
}

describe("quickstart", () => {
  it("qs-01/in-03: one bin, `deco`, that runs under plain Node", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    expect(pkg.bin).toEqual({ deco: "./bin/deco.js" });
    const p = project();
    const help = p.deco("--help");
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/schema/);
  });

  it("qs-02: engines.node is >=24", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=24");
  });

  it(
    "qs-02/qs-04/qs-08/qs-11/qs-15: the quickstart runs end to end under tsx, and edits change the result",
    () => {
      const p = quickstart();
      // The plain-function version first.
      p.write(
        "direct.ts",
        `import experiments from "./experiments";\nconsole.log(JSON.stringify(experiments({ newCheckout: 10, stickyHeader: 50, freeShippingBanner: 0 })));\n`,
      );
      const direct = p.run(TSX, ["direct.ts"]);
      expect(direct.code, direct.out).toBe(0);
      expect(Object.keys(JSON.parse(direct.out.trim()))).toEqual([
        "newCheckout",
        "stickyHeader",
        "freeShippingBanner",
      ]);

      expect(p.deco("schema").code).toBe(0);
      const content = p.module();
      expect(content.code, content.out).toBe(0);
      expect(p.exists(".deco/blocks.gen.ts")).toBe(true);

      const run1 = p.run(TSX, ["checkout.ts"]);
      expect(run1.code, run1.out).toBe(0);
      expect(JSON.parse(run1.out.trim().split("\n").at(-1)!).freeShippingBanner).toBe(false);

      // Edit the existing file, no module rewrite: newCheckout is true every time.
      p.write(".deco/blocks/Experiments.json", experimentsJson(100));
      for (let i = 0; i < 3; i++) {
        const run = p.run(TSX, ["checkout.ts"]);
        expect(run.code, run.out).toBe(0);
        expect(JSON.parse(run.out.trim().split("\n").at(-1)!).newCheckout).toBe(true);
      }
    },
    T,
  );

  it(
    "qs-03/qs-11: `satisfies Blocks` keeps exact types; the quickstart typechecks",
    () => {
      const p = quickstart();
      expect(p.module().code).toBe(0);
      p.write(
        "types.ts",
        `import blocks from "./.deco";
import type { Blocks } from "@decocms/blocks";
import type { Experiments } from "./experiments";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
assert<Equal<Parameters<typeof blocks.experiments>[0], Experiments>>();
assert<Equal<ReturnType<typeof blocks.experiments>, { newCheckout: boolean; stickyHeader: boolean; freeShippingBanner: boolean }>>();
const _b: Blocks = blocks;
`,
      );
      const tsc = p.run(TSC, ["-p", "."]);
      expect(tsc.code, tsc.out).toBe(0);
    },
    T,
  );

  it(
    "qs-05: deco schema writes schema.gen.json with @title as label and @minimum/@maximum as range",
    () => {
      const p = quickstart();
      const r = p.deco("schema");
      expect(r.code, r.out).toBe(0);
      const schema = JSON.parse(p.read(".deco/schema.gen.json"));
      const field = objects(schema).find((o) => o.title === "New checkout flow");
      expect(field).toMatchObject({ type: "number", minimum: 0, maximum: 100 });
    },
    T,
  );

  it(
    "qs-07: deco check accepts block type `experiments` next to saved block `Experiments`",
    () => {
      const p = quickstart();
      expect(p.deco("schema").code).toBe(0);
      const r = p.deco("check");
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toMatch(/has the name of/);
    },
    T,
  );

  it(
    "qs-08/in-01/ts-01/tr-12: blocks.gen.ts default-exports { revision, blocks } and imports each JSON file",
    () => {
      const p = quickstart();
      expect(p.module().code).toBe(0);
      const gen = p.read(".deco/blocks.gen.ts");
      expect(gen).toMatch(/import [\w$]+ from "\.\/blocks\/Experiments\.json"/);
      p.write(
        "dump.ts",
        `import content from "./.deco/blocks.gen";\nconsole.log(JSON.stringify(content));\n`,
      );
      const r = p.run(TSX, ["dump.ts"]);
      expect(r.code, r.out).toBe(0);
      const content = JSON.parse(r.out.trim());
      expect(typeof content.revision).toBe("string");
      expect(content.blocks.Experiments).toEqual(experimentsJson(10));
    },
    T,
  );

  it(
    "qs-09/qs-10/mig-13/tr-14: deco check fails on content that doesn't fit, listing each block by file",
    () => {
      const p = quickstart();
      p.write(".deco/blocks/Experiments.json", experimentsJson(200));
      p.write(".deco/blocks/Holiday.json", { __resolveType: "experiments", newCheckout: 5 });
      expect(p.deco("schema").code).toBe(0);
      const r = p.deco("check");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(".deco/blocks/Experiments.json");
      expect(r.out).toContain(".deco/blocks/Holiday.json");
      expect(r.out).toMatch(/newCheckout/);
      expect(r.out).toMatch(/stickyHeader: required/);
      p.write(".deco/blocks/Experiments.json", experimentsJson(10));
      p.write(".deco/blocks/Holiday.json", experimentsJson(1));
      expect(p.deco("check").code).toBe(0);
    },
    T,
  );
});

// --- Next.js guide ------------------------------------------------------------

describe("nextjs guide", () => {
  it(
    "nx-04: the built-in page's sections take JSX-returning blocks in the schema",
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        "src/PromoBanner.tsx": `export interface PromoBannerProps { title: string; href: string }\nexport default function PromoBanner({ title, href }: PromoBannerProps) { return <a href={href}>{title}</a>; }\n`,
        ".deco/index.tsx": `import type { Blocks, Seo } from "@decocms/blocks";
import PromoBanner, { type PromoBannerProps } from "../src/PromoBanner";
export default {
  seo: (input: Seo) => input,
  "promo-banner": (input: PromoBannerProps) => <PromoBanner {...input} />,
} satisfies Blocks;
`,
        ".deco/blocks/Home.json": {
          __resolveType: "page",
          name: "Home",
          path: "/",
          sections: [{ __resolveType: "promo-banner", title: "Hi", href: "/" }],
        },
      });
      const s = p.deco("schema");
      expect(s.code, s.out).toBe(0);
      const c = p.deco("check");
      expect(c.code, c.out).toBe(0);
    },
    T,
  );

  it("nx-02..nx-14: examples/nextjs-smoke matches the guide's files", () => {
    const ex = path.join(REPO, "examples/nextjs-smoke");
    const deps = JSON.parse(fs.readFileSync(path.join(ex, "package.json"), "utf8")).dependencies;
    expect(Object.keys(deps).filter((d) => d.startsWith("@decocms/"))).toEqual(["@decocms/blocks"]);
    expect(deps["server-only"]).toBeDefined();
    for (const file of [
      "src/CartButton.tsx",
      "src/PromoBanner.tsx",
      "src/ProductHero.tsx",
      "src/cms.ts",
      "src/client.server.ts",
      ".deco/index.tsx",
      "src/open-page.server.ts",
      "src/app/[[...path]]/page.tsx",
      "src/app/blog/page.tsx",
    ]) {
      expect(fs.existsSync(path.join(ex, file)), file).toBe(true);
    }
  });

  it(
    "nx-16/nx-24: the posts snippets typecheck once the entry is narrowed with `in` (as examples/nextjs-smoke does)",
    () => {
      // The docs write `match.entry.__resolveType === "post"`, which fails tsc
      // (TS2339: Property '__resolveType' does not exist on type 'Post |
      // StoredPage'): list<T> returns T[], and neither type has the field.
      // The example narrows with `"__resolveType" in match.entry` first.
      const p = project({ "tsconfig.json": TSCONFIG });
      p.write(
        "src/snippet.ts",
        `import type { ReactNode } from "react";
import { matchRoute, type Route, type Redirect, type Block, type Seo, type Client } from "@decocms/blocks";
interface Post extends Route { date: string; body: string }
interface StoredPage extends Route { seo?: Seo | Block; sections: Block[] | Block }
export async function openPage(c: Client, pathname: string) {
  const [pages, pagesError] = await c.list<StoredPage>("page");
  if (pagesError) throw pagesError;
  const [redirects, redirectsError] = await c.list<Redirect>("redirect");
  if (redirectsError) throw redirectsError;
  const [posts, postsError] = await c.list<Post>("post");
  if (postsError) throw postsError;
  const match = matchRoute(pathname, { routes: [...pages, ...posts], redirects });
  if (match.kind !== "match") return null;
  if ("__resolveType" in match.entry && match.entry.__resolveType === "post") {
    return { post: match.entry as Post, blocks: [], seo: null };
  }
  const page = match.entry as StoredPage;
  const sections = Array.isArray(page.sections) ? page.sections : [page.sections];
  const blocks = sections.map((block, index) => ({
    key: \`\${pathname}:\${index}\`,
    result: c.resolve<ReactNode>(block),
  }));
  const seo = c.resolve<Seo | undefined>(page.seo);
  return { post: null, blocks, seo };
}
`,
      );
      const tsc = p.run(TSC, ["-p", "."]);
      expect(tsc.code, tsc.out).toBe(0);
    },
    T,
  );

  it(
    "nx-21/nx-25/nx-10: Result, Redirect and matchRoute work in a proxy.ts as the guide describes",
    () => {
      const p = project({ "tsconfig.json": TSCONFIG });
      p.write(
        "src/proxy.ts",
        `import { NextResponse, type NextRequest } from "next/server";
import { matchRoute, type Redirect, type Result } from "@decocms/blocks";
declare const redirects: Redirect[];
export function proxy(request: NextRequest) {
  const match = matchRoute(request.nextUrl.pathname, { routes: [], redirects });
  if (match.kind === "redirect") return NextResponse.redirect(new URL(match.location, request.url), match.status);
  return NextResponse.next();
}
const ok: Result<number> = [1, null];
const statuses: Redirect["status"][] = [301, 302, 307, 308];
export { ok, statuses };
`,
      );
      const tsc = p.run(TSC, ["-p", "."]);
      expect(tsc.code, tsc.out).toBe(0);
    },
    T,
  );
});

// --- TanStack Start guides ------------------------------------------------------

describe("tanstack-start guides", () => {
  it(
    "rsc-01: deco schema reads .deco/index.tsx when there is no .deco/index.ts",
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        ".deco/index.tsx": `import type { Blocks } from "@decocms/blocks";\nexport default { hello: (input: { name: string }) => <p>{input.name}</p> } satisfies Blocks;\n`,
      });
      const r = p.deco("schema");
      expect(r.code, r.out).toBe(0);
      expect(p.exists(".deco/schema.gen.json")).toBe(true);
    },
    T,
  );

  it("ts-09/ts-10/ts-01: examples/tanstack-smoke uses the guide's Vite, Wrangler and tsconfig setup", () => {
    const ex = path.join(REPO, "examples/tanstack-smoke");
    const vite = fs.readFileSync(path.join(ex, "vite.config.ts"), "utf8");
    expect(vite).toContain(
      'cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react()',
    );
    // The one deco piece is the dev-only content reload plugin ("Edit in the site editor").
    expect(vite).toContain('import { decoContent } from "@decocms/blocks/vite";');
    expect(vite).toContain("decoContent()");
    expect(vite.match(/@decocms\/[\w/-]+/g)).toEqual(["@decocms/blocks/vite"]);
    const wrangler = fs.readFileSync(path.join(ex, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"main": "@tanstack/react-start/server-entry"');
    expect(wrangler).toContain('"nodejs_compat", "no_handle_cross_request_promise_resolution"');
    const tsconfig = JSON.parse(fs.readFileSync(path.join(ex, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions.resolveJsonModule).toBe(true);
    const deps = JSON.parse(fs.readFileSync(path.join(ex, "package.json"), "utf8")).dependencies;
    expect(Object.keys(deps).filter((d) => d.startsWith("@decocms/"))).toEqual(["@decocms/blocks"]);
  });

  it("rsc-03/rsc-04: an RSC variant of the TanStack example exists and builds", () => {
    const candidates = fs.readdirSync(path.join(REPO, "examples")).filter((d) => /rsc/i.test(d));
    expect(candidates.length).toBeGreaterThan(0);
  });
});

// --- migrating from v7 ------------------------------------------------------------

describe("renames and migrations", () => {
  it(
    "mig-03/mig-05/tr-08: legacy page names pass check; an alias or type colliding with a saved block fails",
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        ".deco/index.ts": `import type { Blocks } from "@decocms/blocks";
const card = (input: { title: string }) => input;
export default { "product-card": card, Foo: card } satisfies Blocks;
`,
        ".deco/blocks/Old.json": {
          __resolveType: "website/pages/Page.tsx",
          name: "Old",
          path: "/old",
          sections: [],
        },
      });
      expect(p.deco("schema").code).toBe(0);
      const ok = p.deco("check");
      expect(ok.code, ok.out).toBe(0);
      p.write(".deco/blocks/Foo.json", { __resolveType: "product-card", title: "x" });
      const bad = p.deco("check");
      expect(bad.code).not.toBe(0);
      expect(bad.out).toMatch(/Foo\.json[\s\S]*has the name of a block type/);
    },
    T,
  );
});

// --- troubleshooting ---------------------------------------------------------------

describe("troubleshooting", () => {
  it("tr-13: `no .deco/ found` outside an app; --root fixes it", () => {
    const empty = project({}, false);
    const r = empty.deco("schema");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no .deco/ found");
    const app = quickstart();
    const viaRoot = empty.module(app.root);
    expect(viaRoot.code, viaRoot.out).toBe(0);
    expect(app.exists(".deco/blocks.gen.ts")).toBe(true);
  });

  it("tr-15: typescript is a peer dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    expect(pkg.peerDependencies.typescript).toBeDefined();
  });

  it(
    "tr-17: literal unions, enums and @options become pickers",
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        ".deco/index.ts": `import type { Blocks } from "@decocms/blocks";
export enum Tone { Light = "light", Dark = "dark" }
export interface Props {
  size: "sm" | "md" | "lg";
  tone: Tone;
  /** @options ["left", "center"] */
  align: string;
}
export default { box: (input: Props) => input } satisfies Blocks;
`,
      });
      expect(p.deco("schema").code).toBe(0);
      const all = objects(JSON.parse(p.read(".deco/schema.gen.json")));
      const enums = all
        .filter((o) => Array.isArray(o.enum))
        .map((o) => (o.enum as string[]).join(","));
      expect(enums).toContain("sm,md,lg");
      expect(enums).toContain("light,dark");
      expect(all.some((o) => JSON.stringify(o.options ?? o.enum ?? "").includes("center"))).toBe(
        true,
      );
    },
    T,
  );
});

// --- internals ---------------------------------------------------------------------

describe("internals", () => {
  it(
    "in-02: the revision is a hash of the content: equal anywhere, new on any change",
    () => {
      const a = quickstart();
      const b = quickstart();
      const rev = (p: Project) => /revision: "([^"]+)"/.exec(p.read(".deco/blocks.gen.ts"))?.[1];
      expect(a.module().code).toBe(0);
      expect(b.module().code).toBe(0);
      expect(rev(a)).toBeDefined();
      expect(rev(a)).toBe(rev(b));
      b.write(".deco/blocks/Experiments.json", experimentsJson(11));
      expect(b.module().code).toBe(0);
      expect(rev(b)).not.toBe(rev(a));
    },
    T,
  );

  it("in-04/in-10: the cli and protocol subpaths are exported", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    expect(pkg.exports["./cli"]).toBeDefined();
    expect(pkg.exports["./protocol"]).toBeDefined();
  });

  it("in-05: deco check never loads TypeScript (its module graph has no typescript import)", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from "typescript"|import\("typescript"\)/);
      for (const [, spec] of text.matchAll(/^import (?!type )[^;]*?from "(\.[^"]+)"/gms)) {
        const base = path.resolve(path.dirname(file), spec);
        const resolved = [base, `${base}.ts`, `${base}/index.ts`].find(
          (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
        );
        if (resolved) visit(resolved);
      }
    };
    visit(path.join(PACKAGE, "src/v8/cli/check/index.ts"));
    expect([...seen].some((f) => f.endsWith("tsProgram.ts"))).toBe(false);
  });

  const CHECK_INDEX = `import type { Blocks } from "@decocms/blocks";
export interface PromoProps {
  /** @maxLength 60 */
  title: string;
  size: "sm" | "md" | "lg";
}
export interface Product { name: string }
export default {
  promo: (input: PromoProps) => <div>{input.title}</div>,
  product: (input: { name: string }): Product => input,
  count: (input: { n: number }): number => input.n,
  card: (input: { product: Product }) => input,
} satisfies Blocks;
`;

  it(
    "in-06/in-09/tr-14: errors name file and field, grouped by file, in plain wording",
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        ".deco/index.tsx": CHECK_INDEX,
        ".deco/blocks/HomePage.json": {
          __resolveType: "page",
          name: "Home",
          path: "/",
          sections: [
            { __resolveType: "promo", title: "ok", size: "sm" },
            { __resolveType: "promo", title: "ok", size: "md" },
            { __resolveType: "promo", title: "x".repeat(214), size: "xl" },
          ],
        },
        ".deco/blocks/NoTitle.json": { __resolveType: "promo", size: "sm" },
      });
      expect(p.deco("schema").code).toBe(0);
      const r = p.deco("check");
      expect(r.code).not.toBe(0);
      // Grouped by file (troubleshooting: "lists each problem under the file
      // it's in"), each line naming the field: the file › field pair the
      // internals page describes.
      expect(r.out).toMatch(/^\.deco\/blocks\/HomePage\.json\n {2}sections\[2\]\.title: /m);
      expect(r.out).toContain("title: 214 characters, max 60");
      expect(r.out).toContain('size: "xl" isn\'t one of "sm", "md", "lg"');
      expect(r.out).toContain("title: required");
    },
    T,
  );

  it(
    'in-07: an unknown block type is one error, `no saved block or block type "promo-banner"`',
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        ".deco/index.tsx": CHECK_INDEX,
        ".deco/blocks/HomePage.json": {
          __resolveType: "page",
          name: "Home",
          path: "/",
          sections: [{ __resolveType: "promo-banner", title: "x" }],
        },
      });
      expect(p.deco("schema").code).toBe(0);
      const r = p.deco("check");
      expect(r.code).not.toBe(0);
      const lines = r.out.split("\n").filter((l) => /^\s+\S/.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('no saved block or block type "promo-banner"');
    },
    T,
  );

  it(
    "in-08: a reference is checked against the return type of the function behind it",
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        ".deco/index.tsx": CHECK_INDEX,
        ".deco/blocks/Shirt.json": { __resolveType: "product", name: "Shirt" },
        ".deco/blocks/Three.json": { __resolveType: "count", n: 3 },
        ".deco/blocks/Good.json": { __resolveType: "card", product: { __resolveType: "Shirt" } },
      });
      expect(p.deco("schema").code).toBe(0);
      expect(p.deco("check").code).toBe(0);
      p.write(".deco/blocks/Bad.json", {
        __resolveType: "card",
        product: { __resolveType: "Three" },
      });
      const r = p.deco("check");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("Bad.json");
    },
    T,
  );

  it("in-11: one core package, @decocms/blocks; the framework bindings and upstream clients depend only on it", () => {
    const manifest = (name: string) =>
      JSON.parse(fs.readFileSync(path.join(REPO, "packages", name, "package.json"), "utf8"));
    const deco = (name: string) => {
      const m = manifest(name);
      return Object.keys({ ...m.dependencies, ...m.peerDependencies }).filter((d) =>
        d.startsWith("@decocms/"),
      );
    };
    const packages = fs
      .readdirSync(path.join(REPO, "packages"))
      .filter((d) => fs.existsSync(path.join(REPO, "packages", d, "package.json")));
    // The framework bindings (@decocms/tanstack, @decocms/nextjs) never import each other.
    const BINDINGS = ["tanstack", "nextjs"];
    // @decocms/compat-v7: v7's pure helpers, approved by the product owner
    // (2026-10-14) as their one home. Its /tanstack and /nextjs subpaths take
    // a binding as an optional peer; nothing here depends on it (its guardrail,
    // tests/compat-v7.guardrail.test.ts).
    const COMPAT = "compat-v7";
    expect(
      packages.filter((d) => !d.startsWith("apps-") && !BINDINGS.includes(d) && d !== COMPAT),
    ).toEqual(["blocks"]);
    expect(packages.filter((d) => d.startsWith("apps-")).length).toBe(7);
    expect(deco("blocks")).toEqual([]);
    for (const dependent of packages.filter((d) => d !== "blocks" && d !== COMPAT)) {
      expect([dependent, deco(dependent)]).toEqual([dependent, ["@decocms/blocks"]]);
    }
    const compat = manifest(COMPAT);
    expect(compat.peerDependencies["@decocms/blocks"]).toBeDefined();
    for (const binding of deco(COMPAT).filter((d) => d !== "@decocms/blocks")) {
      expect(["@decocms/tanstack", "@decocms/nextjs"]).toContain(binding);
      expect(compat.peerDependenciesMeta?.[binding]?.optional).toBe(true);
    }
  });
});

// --- design decisions --------------------------------------------------------------

describe("design decisions", () => {
  it(
    "dd-04: deco schema reads only the default export",
    () => {
      const p = project({
        "tsconfig.json": TSCONFIG,
        ".deco/index.ts": `import type { Blocks } from "@decocms/blocks";
export const extra = { ghost: (input: { boo: string }) => input };
export default { real: (input: { zzRealField: string }) => input } satisfies Blocks;
`,
      });
      expect(p.deco("schema").code).toBe(0);
      const text = p.read(".deco/schema.gen.json");
      expect(text).toContain("zzRealField");
      expect(text).not.toContain("ghost");
    },
    T,
  );

  it("dd-06: the commands; schema takes --watch or --check; every command takes --root and --json", () => {
    const p = project();
    const help = p.deco("--help").out;
    const commands = [...help.matchAll(/^ {2}(\w+) {2,}/gm)].map((m) => m[1]);
    expect(commands.sort()).toEqual(
      ["check", "diff", "drafts", "login", "publish", "pull", "push", "releases", "schema"].sort(),
    );
    expect(help).toMatch(/deco schema\s+\[--watch \| --check\]/);
    expect(help).toMatch(/deco schema push/);
    expect(help).toMatch(/deco check\s+\[--draft=<name> \| --revision=<id>\]/);
    expect(help).toMatch(
      /Every command finds \.deco\/ by walking up from the current folder, or takes --root/,
    );
    expect(help).toMatch(/Every command takes --json/);
    expect(help).not.toMatch(/deco serve|deco content/);
  });

  it("dd-09: `deco publish` needs a draft: it never publishes without one", () => {
    const p = quickstart();
    const r = p.deco("publish");
    expect(r.code).toBe(64);
    expect(r.out).toContain("--draft=<name>");
  });
});
