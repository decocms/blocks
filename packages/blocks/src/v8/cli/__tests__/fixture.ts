/**
 * Test-only (`__tests__/` is left out of the published package, see `files`
 * in package.json). Fixture projects for the CLI's tests: a temp folder with a `.deco/`, real
 * TypeScript sources and the workspace's `node_modules` linked in, so
 * `deco schema` resolves `react` types like it would in an app.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockNameFromFile, checkBlockName, isBlockFileName } from "../../../protocol/keys";
import { readSavedBlocks } from "../content";
import type { Reporter } from "../log";
import { findDecoRoot } from "../root";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_NODE_MODULES = path.resolve(HERE, "../../../../../../node_modules");
const TSX = path.join(WORKSPACE_NODE_MODULES, ".bin/tsx");

/** The types an app imports from `@decocms/blocks` (spec: api-reference › Types). */
export const DECO_TYPES = `
import type { ReactNode } from "react";
export type Lazy<T> = () => Promise<T>;
export type BlockFunction = (inputs: any) => unknown | Promise<unknown>;
export type Blocks = Record<string, BlockFunction>;
export interface Route { name: string; path: string }
export interface Seo { title: string; description: string }
export interface Page extends Route { seo?: Seo; sections: ReactNode[] }
`;

export interface Fixture {
  root: string;
  write(file: string, content: string | object): string;
  read(file: string): string;
  exists(file: string): boolean;
  remove(): void;
}

/** A fixture project; `files` maps paths relative to the root to their content. */
export function createFixture(files: Record<string, string | object> = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-cli-")));
  const fixture: Fixture = {
    root,
    write(file, content) {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(
        full,
        typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      );
      return full;
    },
    read: (file) => fs.readFileSync(path.join(root, file), "utf8"),
    exists: (file) => fs.existsSync(path.join(root, file)),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  fs.mkdirSync(path.join(root, ".deco", "blocks"), { recursive: true });
  if (fs.existsSync(WORKSPACE_NODE_MODULES)) {
    fs.symlinkSync(WORKSPACE_NODE_MODULES, path.join(root, "node_modules"), "dir");
  }
  fixture.write("package.json", { name: "fixture-site", private: true, type: "module" });
  fixture.write("src/deco.ts", DECO_TYPES);
  for (const [file, content] of Object.entries(files)) fixture.write(file, content);
  return fixture;
}

/** A reporter that records what a command printed. */
export function recorder(): Reporter & {
  lines: { level: string; message: string }[];
  text(): string;
} {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    info: (message) => lines.push({ level: "info", message }),
    warn: (message) => lines.push({ level: "warn", message }),
    error: (message) => lines.push({ level: "error", message }),
    text: () => lines.map((l) => l.message).join("\n"),
  };
}

/**
 * A small store: a hero section, a product card that takes a `Product`, a
 * catalog loader that returns one, a matcher, data-only `post` and `menu`
 * blocks, a `vault` section with lists of strings and lazy values (and
 * methods), and a legacy alias key.
 */
export const STORE_FILES: Record<string, string> = {
  "src/model.ts": `
import type { Route } from "./deco";
export interface Product { name: string; price: number }
export interface Post extends Route {
  /** @format rich-text */
  body: string;
  featured?: Post;
}
export interface Menu { items: string[] }
export enum Tone { Light = "light", Dark = "dark" }
`,
  "src/hero.tsx": `
import type { ReactNode } from "react";
import type { Lazy } from "./deco";
import type { Product, Tone } from "./model";

/** @title Hero props */
export interface HeroProps {
  /**
   * @title Headline
   * @maxLength 60
   */
  title: string;
  /** @format image-uri */
  image?: string;
  size: "sm" | "md" | "lg";
  tone?: Tone;
  /** @options ["left", "center", "right"] */
  align?: string;
  /** @options site/loaders/icons.ts */
  icon?: string;
  /**
   * @minimum 1
   * @maximum 10
   * @default 3
   */
  count?: number;
  dark?: boolean;
  tags?: string[];
  /** @ignore */
  internal?: string;
  product?: Product;
  later?: Lazy<Product>;
  children?: ReactNode;
  sections?: ReactNode[];
}

/**
 * The big banner at the top.
 * @title Hero
 */
export default function Hero(props: HeroProps) {
  return <div>{props.title}</div>;
}
`,
  "src/blocks.tsx": `
import type { Product, Post, Menu } from "./model";

export async function catalogProduct(props: { slug: string }): Promise<Product> {
  return { name: props.slug, price: 1 };
}
export function productList(props: { count: number }): Product[] {
  return [];
}
export const productCard = (props: { title: string; product: Product; related?: Product[] }) => (
  <div>{props.title}</div>
);
export const weekday = (props: { days: ("Sat" | "Sun")[] }) => props.days.length > 0;
export const greeting = (props: { name: string }) => "hello " + props.name;
export const descriptor = (props: { title: string }) => ({ component: "promo", props });
export interface Rendered { component: string; props: unknown }
export const shelf = (props: { heading: Rendered; rows: Rendered[] }) => <div>{props.rows.length}</div>;
export const post = (props: Post) => props;
export const menu = (props: Menu) => props;
export const footer = (props: { menu: Menu; enabled: boolean; label: string }) => <footer />;
`,
  "src/vault.tsx": `
import type { Lazy } from "./deco";
import type { Product } from "./model";

export interface VaultProps {
  label?: string;
  keys?: string[];
  slots?: Lazy<Product>[];
  /** Methods aren't fields, even ones returning a promise. */
  onLoad?: () => Promise<void>;
  refresh: () => Promise<Product>;
}
export const vault = (props: VaultProps) => <div>{props.label}</div>;
`,
  ".deco/index.ts": `
import type { Blocks } from "../src/deco";
import Hero from "../src/hero";
import { vault } from "../src/vault";
import { catalogProduct, productList, productCard, weekday, greeting, descriptor, shelf, post, menu, footer } from "../src/blocks";

export default {
  hero: Hero,
  "product-card": productCard,
  "catalog-product": catalogProduct,
  "product-list": productList,
  weekday,
  greeting,
  descriptor,
  shelf,
  post,
  menu,
  footer,
  vault,
  "site/sections/Hero.tsx": Hero,
} satisfies Blocks;
`,
};

/** The revision `folderAsProduction` serves the folder as. */
export const FOLDER_REVISION = "fe5e5eb831ff-01a1a147-ce00-7000-8000-000000000000";

/**
 * The folder as a published revision would hold it: what `readSavedBlocks`
 * reads, plus the files whose name the file-name rule rejects, under their
 * names, so a check of it still reports them.
 */
function folderBlocks(dir: string): Record<string, unknown> {
  const blocks: Record<string, unknown> = { ...readSavedBlocks(dir).blocks };
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const name = blockNameFromFile(file);
    if (!isBlockFileName(file) || checkBlockName(name).length === 0) continue;
    try {
      blocks[name] = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {}
  }
  return blocks;
}

/**
 * The CDN's answer when production is the `.deco/blocks` of `root()`:
 * `latest.json` names `FOLDER_REVISION`, whose `data.json` holds the blocks.
 */
export function folderAnswer(url: string, root: string): { status: number; body: unknown } {
  if (url.endsWith("/latest.json")) return { status: 200, body: { revision: FOLDER_REVISION } };
  if (url.endsWith(`/revisions/${FOLDER_REVISION}/data.json`)) {
    return {
      status: 200,
      body: { blocks: folderBlocks(path.join(root, ".deco/blocks")) },
    };
  }
  return { status: 404, body: { error: "not found" } };
}

/**
 * `deco check` with no flag checks production, from the CDN (contract §7.3).
 * For tests about checking itself, this serves a fixture's own
 * `.deco/blocks` as production, in process: pass `env` and `fetch` to `runCli`.
 */
export function folderAsProduction(root: () => string) {
  return {
    env: { DECO_SITE: "fixture", DECO_DELIVERY_URL: "https://cdn.test" } as Record<string, string>,
    fetch: async (input: string | URL | Request) => {
      const answer = folderAnswer(String(input instanceof Request ? input.url : input), root());
      return Response.json(answer.body, { status: answer.status });
    },
  };
}

/**
 * `folderAsProduction` for one `deco` invocation run in process: production
 * from the `.deco/` root the command would use (`--root`, else walking up
 * from `cwd`), for a `deco check` with no `--draft` or `--revision`; nothing
 * for any other command.
 */
export function checkProductionFromFolder(argv: string[], cwd: string) {
  if (argv[0] !== "check" || argv.some((a) => /^--(draft|revision)\b/.test(a))) return {};
  const at = argv.findIndex((a) => a === "--root" || a.startsWith("--root="));
  const root = at === -1 ? undefined : argv[at]!.includes("=") ? argv[at]!.slice(7) : argv[at + 1];
  const production = folderAsProduction(() => findDecoRoot({ root, cwd }));
  return { ...production, env: { ...process.env, ...production.env } };
}

/**
 * The same over real HTTP, for a spawned `deco` (even one run with
 * `spawnSync`): a server in its own process (`folderCdn.ts`, under tsx) that
 * serves any folder; `envFor(root)` points a `deco` at that folder's blocks.
 */
export async function startFolderCdn() {
  const child = spawn(TSX, [path.join(HERE, "folderCdn.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.trim());
    });
    child.once("exit", (code) => reject(new Error(`folderCdn exited with ${code}`)));
  });
  return {
    envFor: (root: string) => ({
      DECO_SITE: "fixture",
      DECO_DELIVERY_URL: `http://127.0.0.1:${port}/${Buffer.from(root).toString("base64url")}`,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}
