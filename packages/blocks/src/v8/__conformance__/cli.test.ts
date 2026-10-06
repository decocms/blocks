// @vitest-environment node
/**
 * Docs conformance: the `deco` CLI, `deco schema`, `deco check`, `deco serve`
 * and the content protocol as the local server exposes it.
 *
 * Source of truth: src/content/docs/en/storefront/blocks/next/{cli,schema,checking,site-editor,
 * content-protocol,studio-compatibility,studio-implementation}.mdx in
 * deco-sites/docs-tanstack. Each test is named after the claim it
 * checks (cli-01, sch-03, …). Tests for claims the code doesn't meet yet are
 * left failing on purpose: the fix step turns them green.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../protocol/errors";
import { blockFileName, blockNameFromFile } from "../../protocol/keys";
import {
  createFixture,
  type Fixture,
  recorder,
  STORE_FILES,
  sealSecret,
} from "../cli/__tests__/fixture";
import { runCli } from "../cli/run";
import { type RunningServer, startServer } from "../cli/serve/server";
import { createCMS, resetForTests } from "../cms";
import { matchRoute } from "../matchRoute";
import { remoteLoader } from "../remoteLoader";
import type { Blocks, Loader, Snapshot } from "../types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "../../..");
const REPO = path.resolve(PKG, "../..");
const BIN = path.join(PKG, "bin/deco.js");
const b64 = (name: string) => Buffer.from(name, "utf8").toString("base64");

type Json = Record<string, any>;

async function deco(argv: string[], cwd: string) {
  const out = recorder();
  const code = await runCli(argv, { cwd, reporter: out });
  return { code, out: out.text(), lines: out.lines };
}

/** Snapshot every file (path → bytes) under a folder, skipping node_modules. */
function snapshotTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, "base64");
    }
  };
  walk(dir);
  return files;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json(): any;
}

function raw(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: init.method ?? "POST", headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body.toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function rpcCall(server: RunningServer, body: unknown, headers: Record<string, string> = {}) {
  return raw(server.endpoint, {
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

let nextId = 1;
async function call(server: RunningServer, method: string, params?: unknown): Promise<any> {
  const res = await rpcCall(server, {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    ...(params === undefined ? {} : { params }),
  });
  return res.json();
}

const fixtures: Fixture[] = [];
const servers: RunningServer[] = [];
const tmpDirs: string[] = [];
function fixture(files: Record<string, string | object> = {}): Fixture {
  const f = createFixture(files);
  fixtures.push(f);
  return f;
}
function tmpDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-conf-")));
  tmpDirs.push(d);
  return d;
}
async function serveFixture(
  root: string,
  options: Parameters<typeof startServer>[0] = {},
): Promise<RunningServer & { log: ReturnType<typeof recorder> }> {
  const log = recorder();
  const s = await startServer({ cwd: root, port: 0, reporter: log, ...options });
  servers.push(s);
  return Object.assign(s, { log });
}

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const f of fixtures) f.remove();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A monorepo: `<repo>/.git` and the store app at `<repo>/apps/storefront`. */
function monorepo(files: Record<string, string | object> = STORE_FILES) {
  const app = fixture(files);
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, "apps"));
  const appRoot = path.join(repo, "apps", "storefront");
  fs.cpSync(app.root, appRoot, { recursive: true, verbatimSymlinks: true });
  return { repo, appRoot };
}

// ---------------------------------------------------------------------------
// The schema fixture every schema claim reads: every row of the type table,
// the widget tags, the PromoBanner example and a data-only post.
// ---------------------------------------------------------------------------

const TYPES_FILES: Record<string, string> = {
  "src/model.ts": `
import type { Route } from "@decocms/blocks";
export interface Product { name: string; price: number }
export interface Seo { title: string; description: string }
export interface Post extends Route { body: string }
export interface Hero { title: string }
export enum Tone { Light = "light", Dark = "dark" }
/** @format color */
export type BrandColor = string;
/** @format color */
export type TextTone = "black" | "white";
`,
  "src/sections.tsx": `
import type { ReactNode } from "react";
import type { Lazy, Secret } from "@decocms/blocks";
import type { BrandColor, Hero, Post, Product, Seo, TextTone, Tone } from "./model";

export interface AllProps {
  text: string;
  num: number;
  flag: boolean;
  size: "sm" | "md" | "lg";
  tone: Tone;
  list: string[];
  seo: Seo;
  endsOn?: string;
  one: ReactNode;
  many: ReactNode[];
  apiKey: Secret;
  product: Product;
  later: Lazy<Hero>;
  featured?: Post;
  /**
   * @title Pretty label
   * @description Shown above the fold
   */
  labelled?: string;
  /** @default 10 */
  ten?: number;
  /** @default hello */
  hello?: string;
  /**
   * @minimum 1
   * @maximum 100
   * @minLength 2
   * @maxLength 60
   */
  limited?: string;
  /** @minimum 1 */
  /** @maximum 100 */
  ranged?: number;
  /** @format date */
  fDate?: string;
  /** @format date-time */
  fDateTime?: string;
  /** @format rich-text */
  fRich?: string;
  /** @format textarea */
  fTextarea?: string;
  /** @format color */
  fColor?: string;
  brand?: BrandColor;
  textTone?: TextTone | null;
  palette?: BrandColor[];
  /** @format textarea */
  notes?: BrandColor;
  /** @format image-uri */
  fImage?: string;
  /** @options ["sm", "md", "lg"] */
  picked?: string;
  /** @ignore */
  hidden?: string;
}

/**
 * The everything section.
 * @title Everything
 * @image https://example.com/everything.png
 */
export function everything(props: AllProps) {
  return <div>{props.text}</div>;
}

export async function asyncSection(props: { heading: string }) {
  return <section>{props.heading}</section>;
}

export interface PromoBannerProps {
  /**
   * @title Headline
   * @maxLength 60
   */
  title: string;
  /**
   * @title Image
   * @format image-uri
   */
  image: string;
  /** @title Link */
  href: string;
  /**
   * @title Ends on
   * @format date
   */
  endsOn?: string;
}
export const promoBanner = (props: PromoBannerProps) => <a href={props.href}>{props.title}</a>;

export interface ProductCardProps {
  title: string;
  product: Product; // offers any block whose function returns a Product
}
export const productCard = (props: ProductCardProps) => <div>{props.title}</div>;
`,
  "src/functions.ts": `
import type { Product, Hero, Seo } from "./model";
export async function catalogProduct(props: { slug: string }): Promise<Product> {
  return { name: props.slug, price: 1 };
}
export function syncProduct(props: { sku: string }): Product {
  return { name: props.sku, price: 2 };
}
export const isWeekend = (props: { tz: string }) => props.tz.length > 0;
export const greeting = (props: { name: string }) => "hello " + props.name;
export const answer = (props: { n: number }) => props.n;
export const hero = (props: Hero) => props;
export const seo = (props: Seo) => props;
`,
  ".deco/index.ts": `
import type { Blocks } from "@decocms/blocks";
import type { Post } from "../src/model";
import { everything, asyncSection, promoBanner, productCard } from "../src/sections";
import { catalogProduct, syncProduct, isWeekend, greeting, answer, hero, seo } from "../src/functions";

const post = (props: Post) => props;                     // data only: returns what the editor saved

/** Not a block: named exports are never read. */
export const notABlock = (props: { x: string }) => props.x;
export type AlsoIgnored = { y: number };

export default {
  everything,
  asyncSection,
  promoBanner,
  productCard,
  catalogProduct,
  syncProduct,
  isWeekend,
  greeting,
  answer,
  hero,
  seo,
  post,
} satisfies Blocks;
`,
};

let types: Fixture;
let meta: Json;
let defs: Json;

/** The props schema of a block key (following the allOf to its `@Props` definition). */
function propsOf(key: string): Json {
  const def = defs[b64(key)];
  const ref: string | undefined = def?.allOf?.[0]?.$ref;
  return ref ? defs[ref.replace("#/definitions/", "")] : def;
}
function refsIn(schema: Json): string[] {
  return (schema.anyOf ?? []).map((s: Json) => s.$ref).filter(Boolean);
}
const refTo = (key: string) => `#/definitions/${b64(key)}`;

beforeAll(async () => {
  types = fixture(TYPES_FILES);
  const result = await deco(["schema"], types.root);
  if (result.code !== 0) throw new Error(`deco schema failed:\n${result.out}`);
  meta = JSON.parse(types.read(".deco/schema.gen.json"));
  defs = meta.schema.definitions;
}, 120_000);

// ===========================================================================
// cli.mdx
// ===========================================================================

describe("cli.mdx", () => {
  it("cli-01: deco ships as @decocms/blocks's bin and runs under Node and Bun, and via npx", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
    expect(pkg.bin).toEqual({ deco: "./bin/deco.js" });

    const node = fixture(STORE_FILES);
    const r1 = spawnSync(process.execPath, [BIN, "schema", "--root", node.root], {
      encoding: "utf8",
    });
    expect(r1.status, r1.stderr).toBe(0);
    expect(node.exists(".deco/schema.gen.json")).toBe(true);

    const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
    if (bun.status === 0) {
      const bunFixture = fixture(STORE_FILES);
      const r2 = spawnSync("bun", [BIN, "schema", "--root", bunFixture.root], { encoding: "utf8" });
      expect(r2.status, r2.stderr).toBe(0);
      expect(bunFixture.exists(".deco/schema.gen.json")).toBe(true);
    }

    // `npx @decocms/blocks schema`, from inside an app that has @decocms/blocks installed.
    const viaNpx = fixture(STORE_FILES);
    const r3 = spawnSync("npx", ["--no-install", "@decocms/blocks", "schema"], {
      cwd: viaNpx.root,
      encoding: "utf8",
    });
    expect(r3.status, r3.stderr).toBe(0);
    expect(viaNpx.exists(".deco/schema.gen.json")).toBe(true);
  }, 120_000);

  it("cli-02: the CLI is importable from @decocms/blocks/cli", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
    expect(pkg.exports["./cli"]).toEqual({
      types: "./dist/v8/cli/index.d.ts",
      source: "./src/v8/cli/index.ts",
      default: "./dist/v8/cli/index.js",
    });
    const cli = await import("@decocms/blocks/cli");
    const f = fixture({ ".deco/blocks/A.json": { __resolveType: "hero", title: "x" } });
    const code = await cli.runCli(["content"], { cwd: f.root, reporter: cli.silentReporter });
    expect(code).toBe(0);
    expect(f.read(".deco/blocks.gen.ts")).toContain('"A"');
  });

  it("cli-03: exactly four commands; `deco dev` and others are unknown", async () => {
    const help = await deco(["--help"], tmpDir());
    const commands = [...help.out.matchAll(/^ {2}(\w+) {2,}\S/gm)].map((m) => m[1]);
    expect(commands).toEqual(["schema", "content", "check", "serve"]);
    for (const unknown of ["dev", "build", "init", "generate", "migrate"]) {
      const r = await deco([unknown], tmpDir());
      expect(r.code).toBe(1);
      expect(r.out).toContain(`unknown command "${unknown}"`);
    }
  });

  it("cli-04: deco schema reads .deco/index.ts or .deco/index.tsx and writes schema.gen.json", async () => {
    const ts = fixture(STORE_FILES);
    expect((await deco(["schema"], ts.root)).code).toBe(0);
    expect(ts.exists(".deco/schema.gen.json")).toBe(true);

    const tsx = fixture(STORE_FILES);
    fs.renameSync(path.join(tsx.root, ".deco/index.ts"), path.join(tsx.root, ".deco/index.tsx"));
    expect((await deco(["schema"], tsx.root)).code).toBe(0);
    expect(JSON.parse(tsx.read(".deco/schema.gen.json")).manifest.blocks.sections).toHaveProperty(
      "hero",
    );
  }, 60_000);

  it("cli-05: deco content reads only JSON in .deco/blocks, never the block map", async () => {
    const f = fixture({
      ".deco/index.ts": "this is not TypeScript at all {{{",
      ".deco/blocks/Home.json": { __resolveType: "page", name: "Home", path: "/", sections: [] },
      ".deco/blocks/notes.txt": "not a block",
      ".deco/blocks/README.md": "# nope",
    });
    const r = await deco(["content"], f.root);
    expect(r.code, r.out).toBe(0);
    const mod = f.read(".deco/blocks.gen.ts");
    expect(mod).toContain('"Home"');
    expect(mod).not.toContain("notes");
    expect(mod).not.toContain("README");
    expect(mod).not.toContain("index");
    const src = fs.readFileSync(path.join(PKG, "src/v8/cli/content.ts"), "utf8");
    expect(src).not.toMatch(/blockMapCandidates|index\.tsx?["']|tsProgram|typescript/);
  });

  describe("cli-06: deco check", () => {
    let store: Fixture;
    beforeAll(async () => {
      store = fixture(STORE_FILES);
      expect((await deco(["schema"], store.root)).code).toBe(0);
    }, 60_000);
    beforeEach(() => {
      fs.rmSync(path.join(store.root, ".deco/blocks"), { recursive: true, force: true });
      fs.mkdirSync(path.join(store.root, ".deco/blocks"));
    });

    it("writes nothing, exits 0 on fitting content", async () => {
      store.write(".deco/blocks/Hero.json", { __resolveType: "hero", title: "Hi", size: "md" });
      const before = snapshotTree(store.root);
      const r = await deco(["check"], store.root);
      expect(r.code, r.out).toBe(0);
      expect(snapshotTree(store.root)).toEqual(before);
    });

    it("exits 1 on an invalid block, listing problems per file", async () => {
      store.write(".deco/blocks/Hero.json", { __resolveType: "hero", size: "md" });
      const r = await deco(["check"], store.root);
      expect(r.code).toBe(1);
      expect(r.out).toContain(".deco/blocks/Hero.json\n  title: required");
    });

    it("lists warnings without changing the exit code", async () => {
      const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
      store.write(".deco/blocks/Hero.json", {
        __resolveType: "hero",
        size: "md",
        title: {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "always" }, value: lazy("a") },
            { rule: { __resolveType: "never" }, value: lazy("b") },
          ],
        },
      });
      const r = await deco(["check"], store.root);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/warning/);
      expect(r.out).toMatch(/can never be picked/);
    });

    it("doesn't load TypeScript: an unparseable block map still checks", async () => {
      const original = store.read(".deco/index.ts");
      try {
        store.write(".deco/index.ts", "export default {{{ not typescript");
        store.write(".deco/blocks/Hero.json", { __resolveType: "hero", title: "Hi", size: "md" });
        const r = await deco(["check"], store.root);
        expect(r.code, r.out).toBe(0);
      } finally {
        store.write(".deco/index.ts", original);
      }
    });
  });

  it("cli-07 / cli-22: the predev/prebuild scripts run, and the example apps use them", () => {
    for (const example of ["tanstack-smoke", "nextjs-smoke"]) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(REPO, "examples", example, "package.json"), "utf8"),
      );
      expect(pkg.scripts.predev).toBe("deco schema && deco content");
      expect(pkg.scripts.prebuild).toBe("deco schema && deco content && deco check");
    }

    const app = fixture({
      ...STORE_FILES,
      "package.json": {
        name: "fixture-site",
        private: true,
        type: "module",
        scripts: {
          predev: "deco schema && deco content",
          prebuild: "deco schema && deco content && deco check",
        },
      },
      ".deco/blocks/Home.json": {
        __resolveType: "page",
        name: "Home",
        path: "/",
        sections: [{ __resolveType: "hero", title: "Hi", size: "md" }],
      },
    });
    for (const script of ["predev", "prebuild"]) {
      fs.rmSync(path.join(app.root, ".deco/schema.gen.json"), { force: true });
      fs.rmSync(path.join(app.root, ".deco/blocks.gen.ts"), { force: true });
      const r = spawnSync("npm", ["run", script], { cwd: app.root, encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(app.exists(".deco/schema.gen.json")).toBe(true);
      expect(app.exists(".deco/blocks.gen.ts")).toBe(true);
    }
  }, 120_000);

  it("cli-08: every command walks up from a subfolder; --root is relative to cwd", async () => {
    const f = fixture({
      ...STORE_FILES,
      ".deco/blocks/Hero.json": { __resolveType: "hero", title: "Hi", size: "md" },
    });
    const nested = path.join(f.root, "src", "deep", "er");
    fs.mkdirSync(nested, { recursive: true });
    expect((await deco(["schema"], nested)).code).toBe(0);
    expect(f.exists(".deco/schema.gen.json")).toBe(true);
    expect((await deco(["content"], nested)).code).toBe(0);
    expect(f.exists(".deco/blocks.gen.ts")).toBe(true);
    expect((await deco(["check"], nested)).code).toBe(0);
    const s = await serveFixture(nested);
    expect((await call(s, "describe")).result.root).toBeDefined();
    expect(s.log.text()).toContain("(.deco/schema.gen.json, 1 blocks)");
  }, 60_000);

  it("cli-09: no .deco up the tree gives the documented error", async () => {
    const dir = tmpDir();
    for (const cmd of ["schema", "content", "check", "serve"]) {
      const r = await deco([cmd], dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toBe(`no .deco/ found from ${dir}; run inside your app or pass --root`);
    }
    // Through the real bin too: the message lands on stderr.
    const bin = spawnSync(process.execPath, [BIN, "check"], { cwd: dir, encoding: "utf8" });
    expect(bin.status).not.toBe(0);
    expect(bin.stderr.trim()).toBe(
      `no .deco/ found from ${dir}; run inside your app or pass --root`,
    );
  });

  it("cli-10 / chk-13: --root apps/storefront from the repository root", async () => {
    const { repo, appRoot } = monorepo();
    expect((await deco(["schema", "--root", "apps/storefront"], repo)).code).toBe(0);
    expect(fs.existsSync(path.join(appRoot, ".deco/schema.gen.json"))).toBe(true);
    expect((await deco(["content", "--root", "apps/storefront"], repo)).code).toBe(0);
    expect(fs.existsSync(path.join(appRoot, ".deco/blocks.gen.ts"))).toBe(true);
    expect((await deco(["check", "--root", "apps/storefront"], repo)).code).toBe(0);
    expect(fs.existsSync(path.join(repo, ".deco"))).toBe(false);
  }, 60_000);

  it("cli-11: schema and content take --watch; check and serve reject it", async () => {
    const f = fixture({ ...STORE_FILES });
    let stop!: () => void;
    const until = new Promise<void>((r) => {
      stop = r;
    });
    const out = recorder();
    const running = runCli(["content", "--watch"], { cwd: f.root, reporter: out, until });
    await waitFor(() => f.exists(".deco/blocks.gen.ts"));
    f.write(".deco/blocks/New.json", { __resolveType: "hero", title: "new", size: "sm" });
    await waitFor(() => f.read(".deco/blocks.gen.ts").includes('"New"'));
    stop();
    expect(await running).toBe(0);

    let stop2!: () => void;
    const until2 = new Promise<void>((r) => {
      stop2 = r;
    });
    const running2 = runCli(["schema", "--watch"], {
      cwd: f.root,
      reporter: recorder(),
      until: until2,
    });
    await waitFor(() => f.exists(".deco/schema.gen.json"));
    f.write(
      ".deco/index.ts",
      `${f.read(".deco/index.ts").replace("satisfies Blocks;", "").replace(/}\s*$/, "")}  extra: (p: { z: string }) => p,\n} satisfies Blocks;\n`,
    );
    await waitFor(() => f.read(".deco/schema.gen.json").includes('"extra"'), 20_000);
    stop2();
    expect(await running2).toBe(0);

    for (const cmd of ["check", "serve"]) {
      const r = await deco([cmd, "--watch"], f.root);
      expect(r.code).toBe(1);
      expect(r.out).toContain("unknown flag --watch");
    }
  }, 60_000);

  it("cli-12: deco check takes only --root", async () => {
    const f = fixture();
    for (const flag of ["--port", "--watch", "--json", "--fix"]) {
      const r = await deco(["check", flag], f.root);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`unknown flag ${flag}`);
    }
  });

  it("cli-13: deco serve takes exactly the documented flags", async () => {
    const f = fixture();
    f.write(".deco/schema.gen.json", "{}");
    const { parseFlags } = await import("../cli/run");
    expect(
      parseFlags("serve", [
        "--root",
        ".",
        "--port",
        "1",
        "--host",
        "127.0.0.1",
        "--preview",
        "localhost:8001",
        "--assets",
        "static",
        "--read-only",
      ]),
    ).toEqual({
      root: ".",
      port: "1",
      host: "127.0.0.1",
      preview: "localhost:8001",
      assets: "static",
      "read-only": true,
    });
    for (const flag of ["--watch", "--studio", "--open", "--cors", "--token", "--allow-origin"]) {
      const r = await deco(["serve", flag], f.root);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`unknown flag ${flag}`);
    }
  });

  it("cli-14: --port defaults to 4545", async () => {
    const f = fixture();
    const log = recorder();
    let s: RunningServer;
    try {
      s = await startServer({ cwd: f.root, reporter: log });
    } catch (error) {
      // Something else holds 4545 on this machine: the error names the port.
      expect(String(error)).toContain("port 4545 is in use");
      return;
    }
    servers.push(s);
    expect(s.port).toBe(4545);
    expect(s.endpoint).toBe("http://localhost:4545/rpc");
    expect(log.text()).toContain("http://localhost:4545/rpc");
  });

  it("cli-15: --host defaults to loopback, shown as localhost; another address warns", async () => {
    const f = fixture();
    const loop = await serveFixture(f.root);
    expect(loop.endpoint.startsWith("http://localhost:")).toBe(true);
    expect(loop.log.lines.filter((l) => l.level === "warn")).toEqual([]);

    const open = await serveFixture(f.root, { host: "0.0.0.0" });
    const warns = open.log.lines.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warns.join("\n")).toMatch(/other machines on the network can reach this server/);
  });

  it("cli-16: --preview defaults to the Vite config's port, else http://localhost:5173", async () => {
    const plain = fixture();
    const s1 = await serveFixture(plain.root);
    expect(s1.log.text()).toMatch(/Preview\s+http:\/\/localhost:5173/);
    expect((await call(s1, "describe")).result.preview).toEqual({
      url: "http://localhost:5173",
    });

    const vite = fixture({
      "vite.config.ts": `import { defineConfig } from "vite";\nexport default defineConfig({ server: { port: 3000 } });\n`,
    });
    const s2 = await serveFixture(vite.root);
    expect(s2.log.text()).toMatch(/Preview\s+http:\/\/localhost:3000/);
    expect((await call(s2, "describe")).result.preview).toEqual({
      url: "http://localhost:3000",
    });
  });

  it("cli-17: deco serve has no token: no Authorization, DECO_SERVE_TOKEN ignored, none in the link", async () => {
    const f = fixture();
    process.env.DECO_SERVE_TOKEN = "abc";
    let a: Awaited<ReturnType<typeof serveFixture>>;
    try {
      a = await serveFixture(f.root);
    } finally {
      delete process.env.DECO_SERVE_TOKEN;
    }
    expect("token" in a).toBe(false);
    expect(a.siteEditorUrl).toBe(
      `https://studio.decocms.com/site-editor#endpoint=${encodeURIComponent(a.endpoint)}`,
    );
    expect(a.log.text()).not.toMatch(/token/i);
    const plain = await raw(a.endpoint, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
    });
    expect(plain.status).toBe(200);
    expect(plain.json().result.protocol).toBe("deco-content");
    // An Authorization header is neither needed nor checked.
    const stray = await rpcCall(
      a,
      { jsonrpc: "2.0", id: 1, method: "describe" },
      { authorization: "Bearer anything" },
    );
    expect(stray.status).toBe(200);
  });

  it("cli-18 / cp-42: any origin is answered, its Origin reflected", async () => {
    const f = fixture();
    const s = await serveFixture(f.root);
    for (const origin of ["https://studio.decocms.com", "https://example.com"]) {
      const r = await rpcCall(s, { jsonrpc: "2.0", id: 1, method: "describe" }, { origin });
      expect(r.status).toBe(200);
      expect(r.headers["access-control-allow-origin"]).toBe(origin);
      expect(r.headers.vary).toBe("Origin");
    }
  });

  it("cli-19: --assets is relative to the app root; the field always stores /assets/<name>", async () => {
    const f = fixture();
    const s = await serveFixture(f.root, { assets: "static/img" });
    const r = await raw(s.endpoint.replace("/rpc", "/assets/x.png"), {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    expect(r.json().path).toBe("/assets/x.png");
    expect(f.exists("static/img/x.png")).toBe(true);
    expect(f.exists("public/assets/x.png")).toBe(false);
  });

  it("cli-20 / cp-46: --read-only refuses writes and uploads; describe says so", async () => {
    const f = fixture();
    const s = await serveFixture(f.root, { readOnly: true });
    const d = (await call(s, "describe")).result;
    expect(d.readOnly).toBe(true);
    expect(d.assets).toBeNull();
    const w = await call(s, "blocks.apply", { set: { A: { __resolveType: "hero" } } });
    expect(w.error.code).toBe(ErrorCode.ReadOnly);
    expect(f.exists(".deco/blocks/A.json")).toBe(false);
    const up = await raw(s.endpoint.replace("/rpc", "/assets/x.png"), {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: Buffer.from([1, 2, 3]),
    });
    expect(up.status).toBeGreaterThanOrEqual(400);
    expect(f.exists("public/assets/x.png")).toBe(false);
  });

  it("cli-21 / cp-11: serve reports the app root relative to the repository root", async () => {
    const { repo, appRoot } = monorepo();
    fs.writeFileSync(path.join(appRoot, ".deco/schema.gen.json"), "{}\n");
    const s = await serveFixture(repo, {
      root: "apps/storefront",
      preview: "http://localhost:3001",
    });
    const d = (await call(s, "describe")).result;
    expect(d.root).toBe("apps/storefront");
    expect(d.server.name).toBe("deco-cli");
    expect(d.kind).toBe("working-tree");
    expect(d.refs).toBeNull();
    expect(d.pollIntervalMs).toBe(2000);
    expect(d.assets.dir).toBe("apps/storefront/public/assets");
    expect(d.preview).toEqual({ url: "http://localhost:3001" });
    await call(s, "blocks.apply", { set: { A: { __resolveType: "page", name: "A", path: "/a" } } });
    expect(fs.existsSync(path.join(appRoot, ".deco/blocks/A.json"))).toBe(true);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      if (predicate()) return;
    } catch {
      // not there yet
    }
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ===========================================================================
// schema.mdx
// ===========================================================================

describe("schema.mdx", () => {
  it("sch-01: only the default export is read; each key's form is its first parameter", () => {
    const keys = Object.values(meta.manifest.blocks).flatMap((g: any) => Object.keys(g));
    expect(keys).not.toContain("notABlock");
    expect(keys).not.toContain("AlsoIgnored");
    for (const key of ["everything", "promoBanner", "catalogProduct", "isWeekend", "post"]) {
      expect(keys).toContain(key);
    }
    expect(
      Object.keys(propsOf("catalogProduct").properties).filter((k) => k !== "__resolveType"),
    ).toEqual(["slug"]);
  });

  it("sch-03: the type-to-field table", () => {
    const p = propsOf("everything").properties;
    expect(p.text.type).toBe("string");
    expect(p.num.type).toBe("number");
    expect(p.flag.type).toBe("boolean");
    expect(p.size).toMatchObject({ type: "string", enum: ["sm", "md", "lg"] });
    expect(p.tone).toMatchObject({ type: "string", enum: ["light", "dark"] });
    expect(p.list).toMatchObject({ type: "array", items: { type: "string" } });
    // An object: a group of fields, or a block returning it (seo is such a block).
    const seoInline =
      (p.seo.anyOf ?? [p.seo]).find((s: Json) => s.title === "Inline data") ?? p.seo;
    const seoInlineDef = seoInline.$ref
      ? defs[seoInline.$ref.replace("#/definitions/", "")]
      : seoInline;
    expect(seoInlineDef).toMatchObject({ type: "object" });
    expect(Object.keys(seoInlineDef.properties)).toEqual(["title", "description"]);
    expect(refsIn(p.seo)).toContain(refTo("seo"));
    const required: string[] = propsOf("everything").required;
    expect(required).not.toContain("endsOn");
    expect(required).toContain("text");
    expect(p.one.$ref).toBe("#/definitions/__SECTION_REF__");
    expect(p.many).toMatchObject({
      type: "array",
      items: { $ref: "#/definitions/__SECTION_REF__" },
    });
    expect(p.apiKey).toMatchObject({
      format: "secret",
      writeOnly: true,
      properties: { __resolveType: { enum: ["secret"] }, ciphertext: { type: "string" } },
    });
  });

  it("sch-04 / sch-10 / sch-11: Secret, Lazy and Block are types exported from @decocms/blocks", () => {
    const src = fs.readFileSync(path.join(PKG, "src/index.ts"), "utf8");
    for (const name of ["Secret", "Lazy", "Block", "Blocks", "Route"]) {
      expect(src).toMatch(new RegExp(`type ${name},`));
    }
  });

  it("sch-05 / sch-06: sync and async functions returning Product both fit a `product: Product` field", () => {
    const product = propsOf("productCard").properties.product;
    const refs = refsIn(product);
    expect(refs).toContain(refTo("catalogProduct"));
    expect(refs).toContain(refTo("syncProduct"));
    // …plus a plain value.
    expect(product.anyOf.some((s: Json) => s.title === "Inline data")).toBe(true);
    expect(refs).not.toContain(refTo("greeting"));
  });

  it("sch-07: ReactNode fields offer only JSX-returning functions (sync or async)", () => {
    const sections = meta.manifest.blocks.sections;
    expect(Object.keys(sections)).toEqual(
      expect.arrayContaining(["everything", "asyncSection", "promoBanner", "productCard"]),
    );
    for (const notJsx of ["isWeekend", "greeting", "answer", "catalogProduct", "hero"]) {
      expect(sections).not.toHaveProperty(notJsx);
    }
    const sectionRefs = refsIn(meta.schema.root.sections);
    expect(sectionRefs).toContain(refTo("asyncSection"));
    expect(sectionRefs).not.toContain(refTo("isWeekend"));
    expect(sectionRefs).not.toContain(refTo("greeting"));
  });

  it("sch-08: simple types get a plain input, never block refs", () => {
    const p = propsOf("everything").properties;
    for (const key of ["text", "num", "flag", "size", "tone", "labelled", "picked"]) {
      expect(p[key].anyOf, key).toBeUndefined();
      expect(p[key].$ref, key).toBeUndefined();
    }
    const greetingProps = propsOf("greeting").properties.name;
    expect(greetingProps.anyOf).toBeUndefined();
  });

  it("sch-09: multivariate is a built-in; each rule offers the matchers, value takes T", () => {
    expect(meta.manifest.blocks.loaders).toHaveProperty("multivariate");
    const mv = propsOf("multivariate");
    const variant = mv.properties.variants.items.properties;
    const rule = variant.rule;
    // The rule points at the matchers union: every boolean-returning function.
    const target = rule.$ref ? rule.$ref.replace("#/root/", "") : null;
    const ruleRefs = JSON.stringify(target ? meta.schema.root[target] : rule);
    for (const m of ["always", "never", "date", "isWeekend"]) {
      expect(ruleRefs).toContain(refTo(m));
    }
    expect(ruleRefs).not.toContain(refTo("greeting"));
  });

  it("sch-10: a Lazy<T> field is a lazy block whose value is a T", () => {
    const later = propsOf("everything").properties.later;
    expect(later.properties.__resolveType.enum).toEqual(["lazy"]);
    expect(later.required).toEqual(["__resolveType", "value"]);
    expect(refsIn(later.properties.value)).toContain(refTo("hero"));
  });

  it("sch-12: a reference to a saved block resolves at runtime", async () => {
    resetForTests();
    const card = (p: { title: string }) => ({ card: p.title });
    const holder = (p: { item: unknown }) => p;
    const cms = createCMS({
      blocks: { card, holder } as unknown as Blocks,
      content: {
        revision: "r1",
        blocks: {
          SummerCard: { __resolveType: "card", title: "Summer" },
          Home: { __resolveType: "holder", item: { __resolveType: "SummerCard" } },
        },
      },
    }).forRelease();
    const [value, error] = await cms.resolve("Home");
    expect(error).toBeNull();
    expect(value).toEqual({ item: { card: "Summer" } });
  });

  it("sch-13: @title sets the label; the default comes from the property name", () => {
    const p = propsOf("everything").properties;
    expect(p.labelled.title).toBe("Pretty label");
    // Default: the property name (title-cased by the generator).
    expect(p.text.title?.toLowerCase()).toBe("text");
  });

  it("sch-14: @description sets help text", () => {
    expect(propsOf("everything").properties.labelled.description).toBe("Shown above the fold");
  });

  it("sch-15: @default is parsed as JSON when it can be", () => {
    const p = propsOf("everything").properties;
    expect(p.ten.default).toBe(10);
    expect(p.hello.default).toBe("hello");
  });

  it("sch-16: @minimum/@maximum/@minLength/@maxLength", () => {
    const p = propsOf("everything").properties;
    expect(p.limited).toMatchObject({ minLength: 2, maxLength: 60 });
    expect(p.ranged).toMatchObject({ minimum: 1, maximum: 100 });
  });

  it("sch-17: @format passes through for each documented widget", () => {
    const p = propsOf("everything").properties;
    expect(p.fDate.format).toBe("date");
    expect(p.fDateTime.format).toBe("date-time");
    expect(p.fRich.format).toBe("rich-text");
    expect(p.fTextarea.format).toBe("textarea");
    expect(p.fColor.format).toBe("color");
    expect(p.fImage.format).toBe("image-uri");
  });

  it("sch-26: @format on a type alias reaches every field of that type, a select included", () => {
    const p = propsOf("everything").properties;
    expect(p.brand).toMatchObject({ type: "string", format: "color" });
    expect(p.textTone).toMatchObject({ type: "string", enum: ["black", "white"], format: "color" });
    expect(p.palette.items).toMatchObject({ type: "string", format: "color" });
    expect(p.notes.format).toBe("textarea"); // the field's own tag wins
  });

  it("sch-18 / sch-21: @options, literal unions and enums all become a JSON Schema enum", () => {
    const p = propsOf("everything").properties;
    expect(p.picked).toMatchObject({ type: "string", enum: ["sm", "md", "lg"] });
    expect(p.size.enum).toEqual(["sm", "md", "lg"]);
    expect(p.tone.enum).toEqual(["light", "dark"]);
    // No dynamic-options emission anywhere in the schema.
    const text = JSON.stringify(meta);
    expect(text).not.toMatch(/"options"\s*:\s*"/);
    expect(text).not.toMatch(/"(optionsLoader|dynamicOptions)"/);
  });

  it("sch-19: @ignore leaves the field out", () => {
    expect(propsOf("everything").properties).not.toHaveProperty("hidden");
  });

  it("sch-20: the PromoBannerProps example", () => {
    const s = propsOf("promoBanner");
    expect(s.properties).toEqual({
      title: { type: "string", title: "Headline", maxLength: 60 },
      image: { type: "string", title: "Image", format: "image-uri" },
      href: { type: "string", title: "Link" },
      endsOn: { type: "string", title: "Ends on", format: "date", nullable: true },
    });
    expect(s.required).toEqual(["title", "image", "href"]);
  });

  it("sch-22: the data-only example type-checks and puts post in pages, built-ins included", () => {
    const tsc = path.join(REPO, "node_modules/.bin/tsc");
    types.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          jsx: "react-jsx",
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
        include: [".deco/index.ts", "src/**/*"],
      }),
    );
    const r = spawnSync(tsc, ["-p", types.root], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const g = meta.manifest.blocks;
    expect(g.pages).toHaveProperty("post");
    expect(g.content).toHaveProperty("seo");
    expect(g.pages).toHaveProperty("page");
    expect(g.redirects).toHaveProperty("redirect");
    expect(g.matchers).toHaveProperty("always");
  }, 120_000);

  it("sch-23: posts are listable, routable and resolvable; nested blocks resolve first", async () => {
    resetForTests();
    const post = (p: { name: string; path: string; author: unknown }) => p;
    const author = (p: { name: string }) => ({ author: p.name.toUpperCase() });
    const cms = createCMS({
      blocks: { post, author } as unknown as Blocks,
      content: {
        revision: "r1",
        blocks: {
          Hello: {
            __resolveType: "post",
            name: "Hello",
            path: "/blog/hello",
            author: { __resolveType: "author", name: "ana" },
          },
        },
      },
    }).forRelease();
    const [posts] = await cms.list<{ name: string; path: string }>("post");
    expect(posts?.map((p) => p.path)).toEqual(["/blog/hello"]);
    const match = matchRoute("/blog/hello", { routes: posts ?? [] });
    expect(match).toMatchObject({ kind: "match" });
    const [value] = await cms.resolve("Hello");
    expect(value).toMatchObject({ author: { author: "ANA" } });
  });

  it("sch-24: a `featured: Post` field offers the post block", () => {
    expect(refsIn(propsOf("everything").properties.featured)).toContain(refTo("post"));
  });
});

// ===========================================================================
// checking.mdx
// ===========================================================================

describe("checking.mdx", () => {
  let store: Fixture;
  const check = async (blocks: Record<string, object>) => {
    fs.rmSync(path.join(store.root, ".deco/blocks"), { recursive: true, force: true });
    fs.mkdirSync(path.join(store.root, ".deco/blocks"));
    for (const [name, entry] of Object.entries(blocks)) {
      store.write(`.deco/blocks/${blockFileName(name)}`, entry);
    }
    return deco(["check"], store.root);
  };
  const hero = { __resolveType: "hero", title: "Summer", size: "md" };
  const page = (sections: unknown[], extra: Json = {}) => ({
    __resolveType: "page",
    name: "Home",
    path: "/",
    sections,
    ...extra,
  });
  const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

  beforeAll(async () => {
    store = fixture(STORE_FILES);
    expect((await deco(["schema"], store.root)).code).toBe(0);
  }, 60_000);

  it("chk-01: required fields, enums and limits", async () => {
    for (const bad of [
      { __resolveType: "hero", size: "md" },
      { ...hero, size: "xl" },
      { ...hero, title: "x".repeat(61) },
    ]) {
      const r = await check({ HomePage: page([bad]) });
      expect(r.code, JSON.stringify(bad)).toBe(1);
    }
    expect((await check({ HomePage: page([hero]) })).code).toBe(0);
  });

  it("chk-02: unknown __resolveType; aliases and saved blocks pass", async () => {
    const r = await check({ Promo: { __resolveType: "promo-banner", title: "x" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown block type "promo-banner"');
    const ok = await check({
      Home: { __resolveType: "website/pages/Page.tsx", name: "Home", path: "/", sections: [] },
      SummerHero: hero,
      Other: page([{ __resolveType: "SummerHero" }], { path: "/other", name: "Other" }),
    });
    expect(ok.code, ok.out).toBe(0);
  });

  it("chk-03: a reference must return the field's type", async () => {
    const r = await check({
      MyMenu: { __resolveType: "menu", items: ["a"] },
      Card: { __resolveType: "product-card", title: "x", product: { __resolveType: "MyMenu" } },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(".deco/blocks/Card.json");
  });

  it("chk-04: Lazy<T> fields need a lazy block; lazy only in Lazy<T> fields", async () => {
    const missing = await check({ H: { ...hero, later: { name: "x", price: 1 } } });
    expect(missing.code).toBe(1);
    const misplaced = await check({
      C: { __resolveType: "product-card", title: "x", product: lazy({ name: "x", price: 1 }) },
    });
    expect(misplaced.code).toBe(1);
    const fine = await check({ H: { ...hero, later: lazy({ name: "x", price: 1 }) } });
    expect(fine.code, fine.out).toBe(0);
  });

  it("chk-05 / sch-25: a saved block can't use a type, built-in or alias name", async () => {
    for (const name of ["hero", "page", "website/pages/Page.tsx"]) {
      const r = await check({ [name]: page([], { path: `/${name.length}` }) });
      expect(r.code, name).toBe(1);
      expect(r.out).toContain(`.deco/blocks/${blockFileName(name)}`);
    }
  });

  it("chk-06: no two entries may match the same URL", async () => {
    const r = await check({
      A: page([], { name: "A", path: "/summer" }),
      B: page([], { name: "B", path: "/summer" }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(".deco/blocks/B.json");
    expect(r.out).toMatch(/\/summer/);
  });

  it("chk-07: ciphertext is checked for shape, with no key", async () => {
    const { ciphertext } = await sealSecret("re_123");
    expect(store.exists(".deco/secrets.pub")).toBe(false);
    const ok = await check({ H: { ...hero, apiKey: { __resolveType: "secret", ciphertext } } });
    expect(ok.code, ok.out).toBe(0);
    const bad = await check({
      H: { ...hero, apiKey: { __resolveType: "secret", ciphertext: "v1.nope" } },
    });
    expect(bad.code).toBe(1);
  });

  it("chk-08: a variant after always is a warning, exit 0", async () => {
    const r = await check({
      H: {
        ...hero,
        title: {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "always" }, value: lazy("a") },
            { rule: { __resolveType: "never" }, value: lazy("b") },
          ],
        },
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/can never be picked/);
  });

  it("chk-09: `npx @decocms/blocks schema && npx @decocms/blocks check`", () => {
    const f = fixture({
      ...STORE_FILES,
      ".deco/blocks/Home.json": page([hero]),
    });
    const r = spawnSync(
      "sh",
      ["-c", "npx --no-install @decocms/blocks schema && npx --no-install @decocms/blocks check"],
      { cwd: f.root, encoding: "utf8" },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120_000);

  it("chk-10: failure output is grouped per file, as in the docs", async () => {
    const r = await check({
      HomePage: page([hero, hero, { __resolveType: "hero", size: "md" }]),
      Promo: { __resolveType: "promo-banner" },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      [
        ".deco/blocks/HomePage.json",
        "  sections[2].title: required",
        ".deco/blocks/Promo.json",
        '  unknown block type "promo-banner"',
      ].join("\n"),
    );
  });

  it("chk-11: content using a field the code doesn't have fails", async () => {
    const r = await check({ H: { ...hero, headline: "renamed" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("headline");
  });

  it("chk-12: deco schema is deterministic (byte-identical, no absolute paths)", async () => {
    const a = fixture(STORE_FILES);
    const b = fixture(STORE_FILES);
    await deco(["schema"], a.root);
    const first = a.read(".deco/schema.gen.json");
    await deco(["schema"], a.root);
    expect(a.read(".deco/schema.gen.json")).toBe(first);
    await deco(["schema"], b.root);
    expect(b.read(".deco/schema.gen.json")).toBe(first);
    expect(first.endsWith("}\n")).toBe(true);
    expect(first).not.toContain(a.root);
    expect(first).not.toContain(os.tmpdir());
  }, 60_000);

  it("chk-15: content saved under an alias still resolves", async () => {
    resetForTests();
    const hero = (p: { title: string }) => ({ hero: p.title });
    const cms = createCMS({
      blocks: { hero } as unknown as Blocks,
      content: {
        revision: "r",
        blocks: { H: { __resolveType: "site/sections/Hero.tsx", title: "x" } },
        aliases: { "site/sections/Hero.tsx": "hero" },
      },
    }).forRelease();
    expect(await cms.resolve("H")).toEqual([{ hero: "x" }, null]);
  });
});

// ===========================================================================
// site-editor.mdx
// ===========================================================================

describe("site-editor.mdx", () => {
  it("se-01: the site editor banner", async () => {
    const { repo, appRoot } = monorepo({
      ...STORE_FILES,
      ".deco/blocks/A.json": { __resolveType: "page", name: "A", path: "/a" },
      ".deco/blocks/B.json": { __resolveType: "page", name: "B", path: "/b" },
    });
    fs.writeFileSync(path.join(appRoot, ".deco/schema.gen.json"), "{}\n");
    const s = await serveFixture(path.join(appRoot, "src"));
    expect(repo).toBeTruthy();
    const lines = s.log.lines.map((l) => l.message);
    const port = s.port;
    expect(lines).toEqual([
      `Deco server          http://localhost:${port}/rpc`,
      "Root                 apps/storefront   (.deco/schema.gen.json, 2 blocks)",
      "Assets               apps/storefront/public/assets   (PUT /assets/<name>)",
      "Preview              http://localhost:5173",
      `Site editor          https://studio.decocms.com/site-editor#endpoint=${encodeURIComponent(`http://localhost:${port}/rpc`)}`,
    ]);
    const url = new URL(s.siteEditorUrl);
    expect(url.search).toBe("");
    expect(url.hash).not.toContain("token");
  });

  it("se-02: the RPC endpoint is /rpc; other paths 404", async () => {
    const f = fixture();
    const s = await serveFixture(f.root);
    expect((await call(s, "describe")).result.protocol).toBe("deco-content");
    const other = await raw(s.endpoint.replace("/rpc", "/api"), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
    });
    expect(other.status).toBe(404);
  });

  it("se-03: serve regenerates the content module after every save", async () => {
    const f = fixture({ "vite.config.ts": "export default {};\n" });
    f.write(".deco/schema.gen.json", "{}\n");
    const s = await serveFixture(f.root);
    await call(s, "blocks.apply", { set: { A: { __resolveType: "page", name: "A", path: "/a" } } });
    expect(f.read(".deco/blocks.gen.ts")).toContain('"A"');
    const before = f.read(".deco/blocks.gen.ts");
    await call(s, "blocks.apply", {
      set: { A: { __resolveType: "page", name: "A", path: "/a", title: "changed" } },
    });
    // The module carries the revision, so an update rewrites it too.
    expect(f.read(".deco/blocks.gen.ts")).not.toBe(before);
    await call(s, "blocks.apply", { delete: ["A"] });
    expect(f.read(".deco/blocks.gen.ts")).not.toContain('"A"');
  });

  it("se-04: serve commits nothing", async () => {
    const f = fixture();
    f.write(".deco/schema.gen.json", "{}\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: f.root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q");
    git("add", "-A", ".deco", "package.json");
    git("commit", "-qm", "init");
    const head = git("rev-parse", "HEAD");
    const s = await serveFixture(f.root);
    await call(s, "blocks.apply", { set: { A: { __resolveType: "page", name: "A", path: "/a" } } });
    expect(f.exists(".deco/blocks/A.json")).toBe(true);
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("se-05 / cp-45: uploads never reuse a name", async () => {
    const f = fixture();
    const s = await serveFixture(f.root);
    const put = (body: Buffer, type = "image/jpeg", name = "summer-banner.jpg") =>
      raw(s.endpoint.replace("/rpc", `/assets/${name}`), {
        method: "PUT",
        headers: { "content-type": type },
        body,
      });
    const ok = (status: number) => status >= 200 && status < 300;
    const first = await put(Buffer.from("first"));
    expect(ok(first.status)).toBe(true);
    expect(first.json().path).toBe("/assets/summer-banner.jpg");
    const second = await put(Buffer.from("second"));
    expect(ok(second.status)).toBe(true);
    expect(second.json().path).not.toBe("/assets/summer-banner.jpg");
    expect(second.json().path).toMatch(/^\/assets\/summer-banner.+\.jpg$/);
    expect(f.read("public/assets/summer-banner.jpg")).toBe("first");
    expect(ok((await put(Buffer.from("<p>"), "text/html")).status)).toBe(false);
    for (const [type, name] of [
      ["video/mp4", "clip.mp4"],
      ["font/woff2", "brand.woff2"],
      ["application/pdf", "terms.pdf"],
    ]) {
      expect(ok((await put(Buffer.from("x"), type, name)).status), type).toBe(true);
    }
    const max = (await call(s, "describe")).result.assets.maxBytes;
    expect(typeof max).toBe("number");
  });

  it("se-06: answers Chrome's local-network preflight, from any origin", async () => {
    const f = fixture();
    const s = await serveFixture(f.root);
    const r = await raw(s.endpoint, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-private-network"]).toBe("true");
    expect(r.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("se-07: describe.secrets.publicKey is .deco/secrets.pub", async () => {
    const without = fixture();
    const s1 = await serveFixture(without.root);
    expect((await call(s1, "describe")).result.secrets).toBeNull();
    const withKey = fixture();
    const { publicKeyPem } = await sealSecret("x");
    withKey.write(".deco/secrets.pub", publicKeyPem);
    const s2 = await serveFixture(withKey.root);
    expect((await call(s2, "describe")).result.secrets).toEqual({ publicKey: publicKeyPem });
  });

  it("se-08: block-level @title, description and @image reach the block's definition", () => {
    const def = defs[b64("everything")];
    expect(def.title).toBe("Everything");
    expect(def.description).toBe("The everything section.");
    expect(def.image).toBe("https://example.com/everything.png");
  });
});

// ===========================================================================
// content-protocol.mdx (through deco serve)
// ===========================================================================

describe("content-protocol.mdx", () => {
  let app: Fixture;
  let s: Awaited<ReturnType<typeof serveFixture>>;
  const entry = (name: string, extra: Json = {}) => ({
    __resolveType: "page",
    name,
    path: `/${name}`,
    ...extra,
  });

  beforeAll(async () => {
    app = fixture(STORE_FILES);
    expect((await deco(["schema"], app.root)).code).toBe(0);
    s = await serveFixture(app.root);
  }, 60_000);

  it("cp-01: no method writes the schema; apply touches only .deco/blocks", async () => {
    const schemaBefore = app.read(".deco/schema.gen.json");
    const before = snapshotTree(path.join(app.root, "src"));
    await call(s, "blocks.apply", { set: { cp01: entry("cp01") } });
    await call(s, "schema.get");
    await call(s, "blocks.list");
    expect(app.read(".deco/schema.gen.json")).toBe(schemaBefore);
    expect(snapshotTree(path.join(app.root, "src"))).toEqual(before);
    expect(app.exists(".deco/blocks/cp01.json")).toBe(true);
  });

  it("cp-02: exactly four methods; anything else is -32601", async () => {
    for (const m of ["describe", "schema.get", "blocks.list"]) {
      expect((await call(s, m)).result, m).toBeDefined();
    }
    for (const m of ["blocks.rename", "blocks.get", "schema.put", "rpc.discover"]) {
      expect((await call(s, m, {})).error.code, m).toBe(ErrorCode.MethodNotFound);
    }
  });

  it("cp-03: POST JSON, single or batch; non-POST rejected", async () => {
    const single = await rpcCall(s, { jsonrpc: "2.0", id: 1, method: "describe" });
    expect(single.json().result).toBeDefined();
    const batch = await rpcCall(s, [
      { jsonrpc: "2.0", id: 1, method: "describe" },
      { jsonrpc: "2.0", id: 2, method: "blocks.list" },
    ]);
    expect(batch.json().map((r: Json) => r.id)).toEqual([1, 2]);
    const get = await raw(s.endpoint, {
      method: "GET",
    });
    expect(get.status).toBeGreaterThanOrEqual(400);
  });

  it("cp-04: params is an object; absent or {} are fine, an array is -32602", async () => {
    expect((await call(s, "describe")).result).toBeDefined();
    expect((await call(s, "describe", {})).result).toBeDefined();
    expect((await call(s, "describe", [])).error.code).toBe(ErrorCode.InvalidParams);
  });

  it("cp-05: a request without an id is rejected and doesn't run", async () => {
    const r = await rpcCall(s, {
      jsonrpc: "2.0",
      method: "blocks.apply",
      params: { set: { cp05: entry("cp05") } },
    });
    expect(r.json().error.code).toBe(ErrorCode.InvalidRequest);
    expect(app.exists(".deco/blocks/cp05.json")).toBe(false);
  });

  it("cp-06: unknown params are rejected and nothing is written", async () => {
    const r = await call(s, "blocks.apply", { set: { cp06: entry("cp06") }, foo: 1 });
    expect(r.error.code).toBe(ErrorCode.InvalidParams);
    expect(app.exists(".deco/blocks/cp06.json")).toBe(false);
  });

  it("cp-07 / cp-41: deco serve never answers 401; 413 for an oversized body, 200 for a conflict", async () => {
    const noAuth = await raw(s.endpoint, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
    });
    expect(noAuth.status).toBe(200);
    const stray = await rpcCall(
      s,
      { jsonrpc: "2.0", id: 1, method: "describe" },
      { authorization: "Bearer nope" },
    );
    expect(stray.status).toBe(200);
    expect(stray.json().error).toBeUndefined();
    // fetch, like a browser: Node's raw http client sees the early 413 as a reset.
    const huge = await fetch(s.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "blocks.apply",
        params: { set: { big: { __resolveType: "page", blob: "x".repeat(9 * 1024 * 1024) } } },
      }),
    });
    expect(huge.status).toBe(413);
    const conflict = await rpcCall(s, {
      jsonrpc: "2.0",
      id: 1,
      method: "blocks.apply",
      params: { set: { cp07: entry("cp07") }, ifMatch: { cp07: "deadbeef" } },
    });
    expect(conflict.status).toBe(200);
    expect(conflict.json().error.code).toBe(ErrorCode.Conflict);
  }, 30_000);

  it("cp-08: batches run in order, aren't atomic, and cap at 10", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "describe",
    }));
    const over = (await rpcCall(s, eleven)).json();
    const code = Array.isArray(over) ? over[0].error?.code : over.error?.code;
    expect(code).toBe(ErrorCode.LimitExceeded);
    const mixed = (
      await rpcCall(s, [
        { jsonrpc: "2.0", id: 1, method: "blocks.apply", params: { set: { cp08: entry("cp08") } } },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "blocks.apply",
          params: { set: { cp08b: entry("cp08b") }, ifMatch: { cp08b: "deadbeef" } },
        },
      ])
    ).json();
    expect(mixed[0].result).toBeDefined();
    expect(mixed[1].error.code).toBe(ErrorCode.Conflict);
    expect(app.exists(".deco/blocks/cp08.json")).toBe(true);
  });

  it("cp-09: gzip when accepted", async () => {
    const r = await rpcCall(
      s,
      { jsonrpc: "2.0", id: 1, method: "schema.get" },
      {
        "accept-encoding": "gzip",
      },
    );
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(r.body).toString()).result.schema).toBeDefined();
  });

  it("cp-10: describe has exactly the documented shape", async () => {
    const d = (await call(s, "describe")).result;
    expect(Object.keys(d).sort()).toEqual(
      [
        "protocol",
        "version",
        "server",
        "kind",
        "readOnly",
        "root",
        "schemaFormat",
        "refs",
        "writes",
        "pollIntervalMs",
        "limits",
        "preview",
        "assets",
        "secrets",
      ].sort(),
    );
    expect(d.protocol).toBe("deco-content");
    expect(d.version.major).toBe(1);
    expect(typeof d.version.minor).toBe("number");
    expect(Object.keys(d.server).sort()).toEqual(["name", "version"]);
    expect(d.schemaFormat).toBe("deco-meta@1");
    expect(Object.keys(d.writes).sort()).toEqual(["idempotency", "schemaPreconditions"]);
    expect(Object.keys(d.limits).sort()).toEqual(
      [
        "maxOpsPerApply",
        "maxBlockBytes",
        "maxRequestBytes",
        "maxListBytes",
        "maxSchemaBytes",
        "maxBatchResponseBytes",
      ].sort(),
    );
    expect(Object.keys(d.assets).sort()).toEqual(["dir", "maxBytes", "urlPrefix"]);
    expect(d.assets.urlPrefix).toBe("/assets/");
  });

  it("cp-12: schema.get with ifNoneMatch", async () => {
    const a = (await call(s, "schema.get")).result;
    expect(a.notModified).toBe(false);
    expect(Object.keys(a).sort()).toEqual(["notModified", "resolvedRef", "schema", "version"]);
    const b = (await call(s, "schema.get", { ifNoneMatch: a.version })).result;
    expect(b).toEqual({ notModified: true, version: a.version });
  });

  it("cp-13: blocks.list with ifNoneMatch; a bad file is a diagnostic", async () => {
    app.write(".deco/blocks/broken.json", "{ not json");
    try {
      const a = (await call(s, "blocks.list")).result;
      expect(Object.keys(a).sort()).toEqual(
        ["blocks", "diagnostics", "notModified", "resolvedRef", "revision", "versions"].sort(),
      );
      expect(a.diagnostics.some((d: Json) => JSON.stringify(d).includes("broken.json"))).toBe(true);
      const b = (await call(s, "blocks.list", { ifNoneMatch: a.revision })).result;
      expect(b).toEqual({ notModified: true, revision: a.revision, resolvedRef: null });
    } finally {
      fs.rmSync(path.join(app.root, ".deco/blocks/broken.json"));
    }
  });

  it("cp-14 / cp-23: apply returns versions, null for deleted (including missing names)", async () => {
    await call(s, "blocks.apply", { set: { cp14old: entry("cp14old") } });
    const r = (
      await call(s, "blocks.apply", {
        set: { cp14: entry("cp14") },
        delete: ["cp14old", "nope-never-existed"],
      })
    ).result;
    expect(Object.keys(r).sort()).toEqual(["revision", "versions"]);
    expect(typeof r.versions.cp14).toBe("string");
    expect(r.versions.cp14old).toBeNull();
    expect(r.versions["nope-never-existed"]).toBeNull();
  });

  it("cp-15: a version on disk is the git blob hash", async () => {
    const r = (await call(s, "blocks.apply", { set: { cp15: entry("cp15") } })).result;
    const hash = execFileSync(
      "git",
      ["hash-object", path.join(app.root, ".deco/blocks/cp15.json")],
      {
        encoding: "utf8",
      },
    ).trim();
    expect(r.versions.cp15).toBe(hash);
  });

  it("cp-16: meta.gen.json fallback; a torn schema is never served", async () => {
    const f = fixture();
    f.write(".deco/meta.gen.json", { manifest: { blocks: {} }, schema: { definitions: {} } });
    const s1 = await serveFixture(f.root);
    expect((await call(s1, "schema.get")).result.schema.manifest).toBeDefined();
    f.write(".deco/schema.gen.json", '{"manifest": {"blocks"');
    const torn = await call(s1, "schema.get");
    expect(torn.result).toBeUndefined();
    expect(torn.error).toBeDefined();
  });

  it("cp-17: ref on the local server is Unsupported", async () => {
    expect((await call(s, "blocks.list", { ref: "main" })).error.code).toBe(ErrorCode.Unsupported);
    expect((await call(s, "schema.get", { ref: "main" })).error.code).toBe(ErrorCode.Unsupported);
  });

  it("cp-18 / cp-21: validation first, every violation at once, nothing written", async () => {
    const r = await call(s, "blocks.apply", {
      set: { "a..b": entry("x"), "": entry("y"), cp18: entry("cp18") },
    });
    expect(r.error.code).toBe(ErrorCode.InvalidBlock);
    const names = r.error.data.violations.map((v: Json) => v.name);
    expect(names).toEqual(expect.arrayContaining(["a..b", ""]));
    expect(app.exists(".deco/blocks/cp18.json")).toBe(false);
  });

  it("cp-19 / cp-39: files are on disk when apply returns, as JSON.stringify(entry, null, 2) + newline", async () => {
    const value = entry("cp19", { nested: { a: [1, 2] } });
    await call(s, "blocks.apply", { set: { cp19: value } });
    expect(app.read(".deco/blocks/cp19.json")).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it("cp-20: set wins over delete", async () => {
    await call(s, "blocks.apply", { set: { cp20: entry("cp20") }, delete: ["cp20"] });
    expect(app.exists(".deco/blocks/cp20.json")).toBe(true);
  });

  it("cp-22: ifMatch conflicts carry expected/actual; null means must not exist", async () => {
    const v = (await call(s, "blocks.apply", { set: { cp22: entry("cp22") } })).result.versions
      .cp22;
    const stale = await call(s, "blocks.apply", {
      set: { cp22: entry("cp22", { x: 1 }) },
      ifMatch: { cp22: "0000" },
    });
    expect(stale.error.code).toBe(ErrorCode.Conflict);
    expect(stale.error.data.entries.cp22).toEqual({ expected: "0000", actual: v });
    const create = await call(s, "blocks.apply", {
      set: { cp22: entry("cp22", { y: 1 }) },
      ifMatch: { cp22: null },
    });
    expect(create.error.code).toBe(ErrorCode.Conflict);
    expect(JSON.parse(app.read(".deco/blocks/cp22.json"))).toEqual(entry("cp22"));
  });

  it("cp-24: rename is one apply with create-only ifMatch", async () => {
    await call(s, "blocks.apply", { set: { cp24old: entry("cp24") } });
    const r = await call(s, "blocks.apply", {
      set: { cp24new: entry("cp24") },
      delete: ["cp24old"],
      ifMatch: { cp24new: null },
    });
    expect(r.result).toBeDefined();
    expect(app.exists(".deco/blocks/cp24old.json")).toBe(false);
    expect(app.exists(".deco/blocks/cp24new.json")).toBe(true);
  });

  it("cp-25: unadvertised requestKey / ifSchemaMatch are rejected, not ignored", async () => {
    const d = (await call(s, "describe")).result;
    if (d.writes.idempotency === null) {
      const r = await call(s, "blocks.apply", { set: { cp25: entry("cp25") }, requestKey: "k1" });
      expect(r.error.code).toBe(ErrorCode.Unsupported);
      expect(app.exists(".deco/blocks/cp25.json")).toBe(false);
    }
    if (d.writes.schemaPreconditions === false) {
      const r = await call(s, "blocks.apply", { set: { cp25: entry("cp25") }, ifSchemaMatch: "v" });
      expect(r.error.code).toBe(ErrorCode.Unsupported);
    }
  });

  it("cp-27: ifSchemaMatch mismatch is a Conflict with schema versions (when advertised)", async () => {
    const d = (await call(s, "describe")).result;
    expect(d.writes.schemaPreconditions).toBe(true);
    const { version } = (await call(s, "schema.get")).result;
    const r = await call(s, "blocks.apply", {
      set: { cp27: entry("cp27") },
      ifSchemaMatch: `${version}-old`,
    });
    expect(r.error.code).toBe(ErrorCode.Conflict);
    expect(r.error.data.schema).toEqual({ expected: `${version}-old`, actual: version });
    const ok = await call(s, "blocks.apply", {
      set: { cp27: entry("cp27") },
      ifSchemaMatch: version,
    });
    expect(ok.result).toBeDefined();
  });

  it("cp-28 / cp-29: the poll batch, and adopting the own write's revision", async () => {
    const { version } = (await call(s, "schema.get")).result;
    const { revision } = (await call(s, "blocks.apply", { set: { cp28: entry("cp28") } })).result;
    const poll = (
      await rpcCall(s, [
        { jsonrpc: "2.0", id: 4, method: "schema.get", params: { ifNoneMatch: version } },
        { jsonrpc: "2.0", id: 5, method: "blocks.list", params: { ifNoneMatch: revision } },
      ])
    ).json();
    expect(poll).toEqual([
      { jsonrpc: "2.0", id: 4, result: { notModified: true, version } },
      { jsonrpc: "2.0", id: 5, result: { notModified: true, revision, resolvedRef: null } },
    ]);
  });

  it("cp-30: the error code table is exactly the documented one", () => {
    expect(ErrorCode).toEqual({
      ParseError: -32700,
      InvalidRequest: -32600,
      MethodNotFound: -32601,
      InvalidParams: -32602,
      InternalError: -32603,
      NotFound: -32001,
      Conflict: -32002,
      InvalidBlock: -32003,
      ReadOnly: -32005,
      Unsupported: -32006,
      LimitExceeded: -32007,
      Unavailable: -32008,
      Unauthorized: -32010,
      Forbidden: -32011,
    });
  });

  it("cp-31: no schema file gives schema: null, and blocks still list and save", async () => {
    const f = fixture();
    const s1 = await serveFixture(f.root);
    expect((await call(s1, "schema.get")).result).toEqual({
      notModified: false,
      version: null,
      resolvedRef: null,
      schema: null,
    });
    const block = { __resolveType: "site/sections/Hero.tsx", title: "Hi", items: [{ n: 1 }] };
    expect((await call(s1, "blocks.apply", { set: { cp31: block } })).result).toBeTruthy();
    expect((await call(s1, "blocks.list")).result.blocks.cp31).toEqual(block);
  });

  it("cp-32: a Secret field holding a plain string is InvalidBlock", async () => {
    const r = await call(s, "blocks.apply", {
      set: { cp32: { __resolveType: "hero", title: "x", size: "md", apiKey: "plaintext" } },
    });
    expect(r.error.code).toBe(ErrorCode.InvalidBlock);
    expect(app.exists(".deco/blocks/cp32.json")).toBe(false);
  });

  it("cp-33 / si-05 / si-06: default limits", async () => {
    const { limits } = (await call(s, "describe")).result;
    expect(limits).toEqual({
      maxOpsPerApply: 500,
      maxBlockBytes: 1024 * 1024,
      maxRequestBytes: 8 * 1024 * 1024,
      maxListBytes: 16 * 1024 * 1024,
      maxSchemaBytes: 16 * 1024 * 1024,
      maxBatchResponseBytes: 32 * 1024 * 1024,
    });
    const set = Object.fromEntries(
      Array.from({ length: 501 }, (_, i) => [`cp33-${i}`, { __resolveType: "page" }]),
    );
    expect((await call(s, "blocks.apply", { set })).error.code).toBe(ErrorCode.LimitExceeded);
  });

  it("cp-35 / cp-36: the file-name rule", () => {
    expect(blockFileName("pages-Home%20Page-6f1e")).toBe("pages-Home%2520Page-6f1e.json");
    expect(blockFileName("collections/blog/posts/abc")).toBe(
      "collections%2Fblog%2Fposts%2Fabc.json",
    );
    expect(blockNameFromFile("a%2Fb.json")).toBe("a/b");
    expect(blockNameFromFile("%E0%A4%A.json")).toBe("%E0%A4%A");
  });

  it("cp-37: two spellings of one name: one entry, a diagnostic, and a write leaves one file", async () => {
    app.write(".deco/blocks/a b.json", entry("ab"));
    app.write(".deco/blocks/a%20b.json", entry("ab", { path: "/ab-winner" }));
    const list = (await call(s, "blocks.list")).result;
    expect(list.blocks["a b"]).toBeDefined();
    expect(list.diagnostics.length).toBeGreaterThan(0);
    await call(s, "blocks.apply", { set: { "a b": entry("ab", { v: 2 }) } });
    const files = fs
      .readdirSync(path.join(app.root, ".deco/blocks"))
      .filter((f) => blockNameFromFile(f) === "a b");
    expect(files).toEqual(["a%20b.json"]);
  });

  it("cp-38: unsaveable names; source-extension names can still be deleted", async () => {
    app.write(".deco/blocks/CaseName.json", entry("CaseName"));
    for (const name of [
      "",
      "a\\b",
      "a..b",
      "a\u0000b",
      "x".repeat(251),
      "casename",
      "CON",
      "__proto__",
      "foo.ts",
      "foo.tsx",
    ]) {
      const r = await call(s, "blocks.apply", { set: { [name]: entry("n") } });
      expect(r.error?.code, JSON.stringify(name)).toBe(ErrorCode.InvalidBlock);
    }
    app.write(".deco/blocks/foo.ts.json", entry("foots"));
    const del = await call(s, "blocks.apply", { delete: ["foo.ts"] });
    expect(del.result).toBeDefined();
    expect(app.exists(".deco/blocks/foo.ts.json")).toBe(false);
  });

  it("cp-40: deco content, deco serve and the fs storage import the protocol's keys", () => {
    const read = (p: string) => fs.readFileSync(path.join(PKG, "src", p), "utf8");
    expect(read("v8/cli/content.ts")).toMatch(/from "\.\.\/\.\.\/protocol\/keys\.ts"/);
    expect(read("v8/cli/serve/server.ts")).toMatch(/protocol\/keys\.ts"/);
    expect(read("protocol/storage/fs/index.ts")).toMatch(/from "\.\.\/\.\.\/keys\.ts"/);
  });

  it("cp-44: non-JSON Content-Type on /rpc is refused", async () => {
    const r = await raw(s.endpoint, {
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
    });
    expect(r.status).toBe(415);
  });

  it("cp-47: the documented protocol subpaths, and no others", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
    const protocol = Object.keys(pkg.exports).filter((k) => k.startsWith("./protocol"));
    expect(protocol.sort()).toEqual(
      [
        "./protocol",
        "./protocol/keys",
        "./protocol/server",
        "./protocol/storage/fs",
        "./protocol/conformance",
      ].sort(),
    );
  });

  it("cp-48: the SDK runtime never imports the protocol; the protocol imports only zod (+ node in fs)", () => {
    const runtimeFiles = fs
      .readdirSync(path.join(PKG, "src/v8"), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.startsWith("cli/") && !f.startsWith("__"));
    const offenders = runtimeFiles.filter((f) =>
      /from "[./]*protocol\//.test(fs.readFileSync(path.join(PKG, "src/v8", f), "utf8")),
    );
    expect(offenders).toEqual([]);
    const SHARED_LEAVES = ["canonical", "ciphertext"].map((m) => path.join(PKG, "src/v8", m));
    for (const leaf of SHARED_LEAVES) {
      expect(fs.readFileSync(`${leaf}.ts`, "utf8"), leaf).not.toMatch(/^import /m);
    }
    const protocolFiles = fs
      .readdirSync(path.join(PKG, "src/protocol"), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("__tests__"));
    for (const f of protocolFiles) {
      // Code only: doc comments show consumers' imports (vitest, the subpath).
      const src = fs
        .readFileSync(path.join(PKG, "src/protocol", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(/(?:^|[\s}])from\s+"([^"]+)"|import\(\s*"([^"]+)"/gm)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith(".")) {
          const target = path
            .resolve(path.dirname(path.join(PKG, "src/protocol", f)), spec)
            .replace(/\.tsx?$/, "");
          // The canonical hash and the ciphertext format are the SDK's own
          // dependency-free leaf modules (no imports at all); the protocol
          // re-exports them rather than keep a second copy.
          if (SHARED_LEAVES.includes(target)) continue;
          expect(target, `${f}: ${spec}`).toContain(path.join(PKG, "src/protocol"));
          continue;
        }
        const ok = spec === "zod" || (spec.startsWith("node:") && f.startsWith("storage/fs/"));
        expect(ok, `${f} imports ${spec}`).toBe(true);
      }
    }
  });

  it("cp-49: the storage interface members", () => {
    const src = fs.readFileSync(path.join(PKG, "src/protocol/storage.ts"), "utf8");
    const iface = src.slice(src.indexOf("export interface ContentStorage"));
    const body = iface.slice(0, iface.indexOf("\n}\n"));
    const members = [...body.matchAll(/^ {2}(\w+)\??\(/gm)].map((m) => m[1]);
    expect(members).toEqual(
      expect.arrayContaining(["snapshot", "readFiles", "readSchema", "commit"]),
    );
  });

  it("cp-50: the conformance suite covers every listed area", async () => {
    const { conformanceCases } = await import("@decocms/blocks/protocol/conformance");
    const ids = conformanceCases.map((c) => c.id);
    for (const id of [
      "apply/atomic-set-delete",
      "apply/set-wins",
      "apply/if-match",
      "apply/schema-precondition",
      "schema/absent",
      "idempotency/retry",
      "idempotency/simultaneous",
      "idempotency/restart",
      "idempotency/tenant-isolation",
      "limits/list-bytes",
      "limits/request-bytes",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("cp-50: deco serve passes the conformance suite", async () => {
    const { runConformance } = await import("@decocms/blocks/protocol/conformance");
    const f = fixture();
    const { publicKeyPem } = await sealSecret("x");
    f.write(".deco/secrets.pub", publicKeyPem);
    fs.copyFileSync(
      path.join(app.root, ".deco/schema.gen.json"),
      path.join(f.root, ".deco/schema.gen.json"),
    );
    const s1 = await serveFixture(f.root);
    const report = await runConformance({
      endpoint: s1.endpoint,
      assetsEndpoint: s1.endpoint.replace("/rpc", "/assets/"),
      secretField: { blockType: "hero", field: "apiKey" },
      secretsPublicKey: publicKeyPem,
    } as never);
    const failed = (report as any).cases?.filter((c: Json) => c.status === "failed") ?? [];
    expect(failed.map((c: Json) => `${c.id}: ${c.error ?? c.message ?? ""}`)).toEqual([]);
  }, 60_000);
});

// ===========================================================================
// studio-compatibility.mdx
// ===========================================================================

describe("studio-compatibility.mdx", () => {
  const groups = () => meta.manifest.blocks;

  it("sc-01 / sc-08: deco-meta@1 with padded-base64 definition keys and schema.root", () => {
    expect(meta.format ?? "deco-meta@1").toBe("deco-meta@1");
    expect(groups().sections.everything.$ref).toBe(`#/definitions/${b64("everything")}`);
    expect(b64("hero")).toBe("aGVybw==");
    expect(defs[b64("post")]).toBeDefined(); // "post" → "cG9zdA==" keeps its padding
    expect(meta.schema.root.sections.anyOf.length).toBeGreaterThan(0);
    for (const g of ["sections", "matchers", "loaders", "content", "pages", "redirects"]) {
      expect(groups()).toHaveProperty(g);
    }
  });

  it("sc-01: the manifest has only the six documented groups", () => {
    expect(Object.keys(groups()).sort()).toEqual(
      ["sections", "matchers", "loaders", "content", "pages", "redirects"].sort(),
    );
  });

  it("sc-02..sc-07: which group each kind of function lands in", () => {
    const g = groups();
    expect(Object.keys(g.sections)).toEqual(
      expect.arrayContaining(["everything", "asyncSection", "promoBanner", "productCard"]),
    );
    expect(Object.keys(g.matchers)).toEqual(
      expect.arrayContaining(["isWeekend", "always", "never", "date"]),
    );
    expect(Object.keys(g.loaders)).toEqual(
      expect.arrayContaining(["catalogProduct", "syncProduct", "greeting", "multivariate", "lazy"]),
    );
    expect(Object.keys(g.pages)).toEqual(expect.arrayContaining(["page", "post"]));
    expect(Object.keys(g.redirects)).toContain("redirect");
    expect(Object.keys(g.content)).toEqual(expect.arrayContaining(["seo", "hero", "cms-settings"]));
  });

  it("sc-02: a render-descriptor-returning function is a section", async () => {
    const f = fixture(STORE_FILES);
    await deco(["schema"], f.root);
    const m = JSON.parse(f.read(".deco/schema.gen.json"));
    expect(m.manifest.blocks.sections).toHaveProperty("descriptor");
  }, 60_000);

  it("sc-05: overriding page replaces the built-in", async () => {
    const f = fixture({
      ...STORE_FILES,
      ".deco/index.ts": `
import type { Blocks, Page } from "../src/deco";
const page = (props: Page & { campaign?: string }) => props;
export default { page } satisfies Blocks;
`,
    });
    expect((await deco(["schema"], f.root)).code).toBe(0);
    const m = JSON.parse(f.read(".deco/schema.gen.json"));
    expect(m.manifest.blocks.pages.page.namespace).not.toBe("deco");
    const pageProps = JSON.stringify(m.schema.definitions);
    expect(pageProps).toContain("campaign");
  }, 60_000);

  it("sc-09: a key is a type if it's in the manifest, a saved block otherwise", async () => {
    resetForTests();
    const card = (p: { t: string }) => ({ card: p.t });
    const cms = createCMS({
      blocks: { card } as unknown as Blocks,
      content: {
        revision: "r",
        blocks: {
          Featured: { __resolveType: "card", t: "saved" },
          Uses: { __resolveType: "Featured" },
          Direct: { __resolveType: "card", t: "type" },
        },
      },
    }).forRelease();
    expect((await cms.resolve("Uses"))[0]).toEqual({ card: "saved" });
    expect((await cms.resolve("Direct"))[0]).toEqual({ card: "type" });
  });

  it("sc-10: the first true variant wins and only it runs", async () => {
    resetForTests();
    const ran: string[] = [];
    const t = (p: { v: string }) => {
      ran.push(p.v);
      return p.v;
    };
    const cms = createCMS({
      blocks: { t } as unknown as Blocks,
      content: {
        revision: "r",
        blocks: {
          X: {
            __resolveType: "multivariate",
            variants: [
              {
                rule: { __resolveType: "never" },
                value: { __resolveType: "lazy", value: { __resolveType: "t", v: "a" } },
              },
              {
                rule: { __resolveType: "always" },
                value: { __resolveType: "lazy", value: { __resolveType: "t", v: "b" } },
              },
              {
                rule: { __resolveType: "always" },
                value: { __resolveType: "lazy", value: { __resolveType: "t", v: "c" } },
              },
            ],
          },
        },
      },
    }).forRelease();
    expect((await cms.resolve("X"))[0]).toBe("b");
    expect(ran).toEqual(["b"]);
  });

  it("sc-11 / sc-16: flat and legacy nested redirects", () => {
    const routes: { name: string; path: string }[] = [];
    expect(
      matchRoute("/campaigns/summer?utm=1", {
        routes,
        redirects: [
          {
            from: "/campaigns/summer",
            to: "/summer",
            permanent: false,
            status: 307,
            discardQueryParameters: true,
          },
        ],
      }),
    ).toMatchObject({ kind: "redirect", location: "/summer", status: 307 });
    const legacy = (type: string) => ({
      __resolveType: "website/loaders/redirect.ts",
      redirect: { from: "/campaigns/summer", to: "/summer", type, discardQueryParameters: true },
    });
    expect(
      matchRoute("/campaigns/summer?utm=1", { routes, redirects: [legacy("permanent") as never] }),
    ).toMatchObject({ kind: "redirect", location: "/summer", status: 301 });
    expect(
      matchRoute("/campaigns/summer?utm=1", { routes, redirects: [legacy("temporary") as never] }),
    ).toMatchObject({ kind: "redirect", location: "/summer", status: 307 });
  });

  it("sc-12: next-major sites serve none of the legacy endpoints; no invoke endpoint", () => {
    const legacy = /live\/_meta|\/\.decofile|live\/previews|deco\/invoke|live\/invoke/;
    const roots = [
      path.join(PKG, "src/v8"),
      path.join(REPO, "examples/tanstack-smoke/src"),
      path.join(REPO, "examples/nextjs-smoke/src"),
    ];
    for (const root of roots) {
      for (const f of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
        if (!/\.(ts|tsx|js)$/.test(f) || /\.test\./.test(f)) continue;
        const src = fs.readFileSync(path.join(root, f), "utf8");
        expect(src.match(legacy)?.[0], `${root}/${f}`).toBeUndefined();
      }
    }
    const src = fs.readFileSync(path.join(PKG, "src/v8/index.ts"), "utf8");
    expect(src).not.toMatch(/invoke/i);
  });

  it("sc-13: the alias table is exactly the documented names, written into the schema", () => {
    const documented = {
      "website/pages/Page.tsx": "page",
      "$live/pages/LivePage.tsx": "page",
      "website/flags/multivariate.ts": "multivariate",
      "website/flags/multivariate/section.ts": "multivariate",
      "website/matchers/always.ts": "always",
      "website/matchers/never.ts": "never",
      "website/loaders/redirect.ts": "redirect",
      "website/loaders/secret.ts": "secret",
    };
    expect(meta.aliases).toEqual(documented);
    const keys = Object.values(groups()).flatMap((g: any) => Object.keys(g));
    for (const alias of Object.keys(documented)) expect(keys).toContain(alias);
  });

  it("sc-14 / sc-15: deco content writes the aliases; createCMS resolves old names lazily", async () => {
    const f = fixture({ ".deco/blocks/H.json": { __resolveType: "website/pages/Page.tsx" } });
    await deco(["content"], f.root);
    const mod = f.read(".deco/blocks.gen.ts");
    expect(mod).toContain('"website/pages/Page.tsx": "page"');
    expect(mod).toContain('"website/flags/multivariate.ts": "multivariate"');

    resetForTests();
    const ran: string[] = [];
    const hero = (p: { v: string }) => {
      ran.push(p.v);
      return p.v;
    };
    const aliases = Object.fromEntries(
      [...mod.matchAll(/^ {4}("[^"]+"): ("[^"]+"),$/gm)].map((m) => [
        JSON.parse(m[1]),
        JSON.parse(m[2]),
      ]),
    );
    const cms = createCMS({
      blocks: { hero } as unknown as Blocks,
      content: {
        revision: "r",
        aliases,
        blocks: {
          Home: { __resolveType: "website/pages/Page.tsx", name: "Home", path: "/", sections: [] },
          V: {
            __resolveType: "website/flags/multivariate.ts",
            variants: [
              {
                rule: { __resolveType: "website/matchers/always.ts" },
                value: { __resolveType: "hero", v: "chosen" },
              },
              {
                rule: { __resolveType: "website/matchers/always.ts" },
                value: { __resolveType: "hero", v: "skipped" },
              },
            ],
          },
        },
      },
    }).forRelease();
    expect((await cms.resolve("Home"))[1]).toBeNull();
    expect((await cms.resolve("V"))[0]).toBe("chosen");
    expect(ran).toEqual(["chosen"]);
  });

  it("sc-17: the v7-to-v8 migration re-encrypts v7 secrets", () => {
    const dir = path.join(REPO, ".agents/skills/deco-v7-to-v8-migration/scripts");
    const all = fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.ts$/.test(f) && !/\.test\./.test(f))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    expect(all).toMatch(/website\/loaders\/secret\.ts/);
    expect(all).toMatch(/encryptToCiphertext|reencrypt|re-encrypt/i);
  });
});

// ===========================================================================
// studio-implementation.mdx
// ===========================================================================

describe("studio-implementation.mdx", () => {
  it("si-02 / si-03 / si-04: canonical hashing, goldens and a separate request-digest domain", async () => {
    const {
      canonicalJson,
      computeContentRevision,
      applyRequestDigest,
      APPLY_DIGEST_DOMAIN,
      sha256Hex,
    } = await import("@decocms/blocks/protocol");
    expect(canonicalJson({ b: 1, a: [2, 1], "10": 0, "9": 0 })).toBe(
      '{"10":0,"9":0,"a":[2,1],"b":1}',
    );
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}');
    for (const bad of [undefined, Number.NaN, () => 1, 1n]) {
      expect(() => canonicalJson({ x: bad }), String(bad)).toThrow();
    }
    const blocks = { a: { __resolveType: "x" } };
    expect(await computeContentRevision(blocks)).not.toBe(
      await applyRequestDigest({ set: blocks }),
    );
    expect(APPLY_DIGEST_DOMAIN).toMatch(/blocks\.apply/);
    expect(await applyRequestDigest({ set: blocks })).toBe(
      await sha256Hex(APPLY_DIGEST_DOMAIN + canonicalJson({ set: blocks })),
    );

    const { contentHashFixtures } = await import("@decocms/blocks/protocol/conformance");
    expect(contentHashFixtures.length).toBeGreaterThan(0);
    for (const fx of contentHashFixtures as any[]) {
      expect(await computeContentRevision(fx.blocks)).toBe(fx.revision ?? fx.hash);
    }
    const content = fs.readFileSync(path.join(PKG, "src/v8/cli/content.ts"), "utf8");
    expect(content).toMatch(/protocol\/canonical\.ts"/);
  });

  it("si-07: the local poll interval is 2 seconds", async () => {
    const f = fixture();
    const s = await serveFixture(f.root);
    expect((await call(s, "describe")).result.pollIntervalMs).toBe(2000);
  });
  describe("si-08 / si-09 / si-10: the SDK's release channel", () => {
    const ORIGIN = "https://delivery.decocms.com";
    const MANIFEST = `${ORIGIN}/sites/acme/channels/production.json`;
    let manifest: Json | undefined;
    const assets = new Map<string, unknown>();
    const gates = new Map<string, Promise<void>>();

    beforeEach(() => {
      resetForTests();
      manifest = undefined;
      assets.clear();
      gates.clear();
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = String(input);
        if (url === MANIFEST)
          return manifest ? Response.json(manifest) : new Response("", { status: 404 });
        const p = url.slice(ORIGIN.length).split("?")[0];
        await gates.get(p);
        return assets.has(p) ? Response.json(assets.get(p)) : new Response("", { status: 404 });
      });
    });
    afterAll(() => vi.unstubAllGlobals());

    async function snap(title: string): Promise<Snapshot> {
      const { computeContentRevision } = await import("@decocms/blocks/protocol");
      const blocks = { S: { __resolveType: "seo", title, description: "d" } };
      return { revision: await computeContentRevision(blocks), blocks };
    }
    function publish(generation: number, s: Snapshot) {
      const p = `/sites/acme/revisions/${s.revision}.json`;
      assets.set(p, s);
      manifest = { format: 1, generation, revision: s.revision, snapshot: p };
      return p;
    }

    it("si-08: 60 s poll with up to 10 s jitter", () => {
      const src = fs.readFileSync(path.join(PKG, "src/v8/cms.ts"), "utf8");
      expect(src).toMatch(/MIN_INTERVAL = 60_000/);
      expect(src).toMatch(/JITTER = 10_000/);
    });

    it("si-09: a stale fetch completion is discarded; a rollback by generation is accepted", async () => {
      const fallback = await snap("bundled");
      const loader = remoteLoader(fallback, { site: "acme", token: "t" }) as Loader;
      const a = await snap("A");
      const b = await snap("B");
      // Gen 5 (B) is slow; gen 6 (A) lands first.
      let release!: () => void;
      const pB = publish(5, b);
      gates.set(
        pB,
        new Promise<void>((r) => {
          release = r;
        }),
      );
      const slow = loader.update!();
      await new Promise((r) => setTimeout(r, 10));
      publish(6, a);
      await loader.update!();
      release();
      await slow;
      expect((await loader.load()).revision).toBe(a.revision);
      // Rollback: gen 7 selects the older revision B.
      publish(7, b);
      expect(await loader.update!()).toEqual({ updated: true });
      expect((await loader.load()).revision).toBe(b.revision);
    });

    it("si-09: a generation change with the same content hash still signals an update", async () => {
      const fallback = await snap("bundled");
      const loader = remoteLoader(fallback, { site: "acme", token: "t" }) as Loader;
      const a = await snap("A");
      publish(1, a);
      expect(await loader.update!()).toEqual({ updated: true });
      publish(2, a); // a new generation (e.g. a re-promotion or rollback) of the same revision
      expect(await loader.update!()).toEqual({ updated: true });
    });

    it("si-10: a draft's changes apply to the production this server has; no matching base is fetched", async () => {
      const fallback = await snap("bundled");
      const published = await snap("published");
      publish(1, published);
      gates.set(`/sites/acme/revisions/${published.revision}.json`, new Promise(() => {})); // never arrives
      const studio = "https://studio.decocms.com/api/acme/decofile/store/b/changes";
      const fetch = globalThis.fetch;
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        urls.push(String(input));
        return String(input).startsWith(studio)
          ? Response.json({ format: 1, set: { New: { __resolveType: "seo" } }, delete: [] })
          : fetch(input);
      });
      const cms = createCMS({ blocks: {}, content: fallback, site: "acme", token: "t" });
      const draft = cms.forDraft("studio.decocms.com/api/acme/decofile/store/b/changes?token=x@c1");
      const [entry] = await draft.resolve("S", { run: false });
      expect(entry).toEqual(fallback.blocks.S); // the bundled release, never waiting for the new one
      expect(urls.filter((url) => url.startsWith(studio))).toHaveLength(1);
      expect(urls.filter((url) => url.includes("/revisions/"))).toHaveLength(0);
    });
  });
});
