/**
 * Test-only (`__tests__/` is left out of the published package, see `files`
 * in package.json). Fixture projects for the CLI's tests: a temp folder with a `.deco/`, real
 * TypeScript sources and the workspace's `node_modules` linked in, so
 * `deco schema` resolves `react` types like it would in an app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretsKeyPair } from "../../../protocol/__tests__/fixtures";
import { encryptToCiphertext } from "../../../protocol/ciphertext";
import type { Reporter } from "../log";

const WORKSPACE_NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../node_modules",
);

/** The types an app imports from `@decocms/blocks` (spec: api-reference › Types). */
export const DECO_TYPES = `
import type { ReactNode } from "react";
export type Lazy<T> = () => Promise<T>;
export type Secret = string & { readonly __secret: true };
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
 * blocks, a `vault` section with lists of secrets and lazy values (and
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
import type { Lazy, Secret } from "./deco";
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
  apiKey?: Secret;
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
export const post = (props: Post) => props;
export const menu = (props: Menu) => props;
export const footer = (props: { menu: Menu; enabled: boolean; label: string }) => <footer />;
`,
  "src/vault.tsx": `
import type { Lazy, Secret } from "./deco";
import type { Product } from "./model";

export interface VaultProps {
  label?: string;
  keys?: Secret[];
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
import { catalogProduct, productList, productCard, weekday, greeting, descriptor, post, menu, footer } from "../src/blocks";

export default {
  hero: Hero,
  "product-card": productCard,
  "catalog-product": catalogProduct,
  "product-list": productList,
  weekday,
  greeting,
  descriptor,
  post,
  menu,
  footer,
  vault,
  "site/sections/Hero.tsx": Hero,
} satisfies Blocks;
`,
};

/** A `.deco/secrets.pub` key and `value` encrypted to it, by the protocol's `encryptToCiphertext`. */
export async function sealSecret(
  value: string,
  modulusLength = 2048,
): Promise<{ ciphertext: string; publicKeyPem: string }> {
  const { publicKeyPem } = await generateSecretsKeyPair(modulusLength);
  return { ciphertext: await encryptToCiphertext(publicKeyPem, value), publicKeyPem };
}
