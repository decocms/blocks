// @vitest-environment node
/**
 * End to end: a small v7 site (sections, an app loader its content calls, a
 * v7 secret, a type with no v8 equivalent) goes through `migrate`, then
 * through `deco schema`, `deco content` and `deco check`, and its content
 * resolves with `createCMS`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCMS, resetForTests } from "@decocms/blocks";
import { check, content, type Reporter, schema } from "@decocms/blocks/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import type { Report } from "./report";

// This skill lives at <repo>/.agents/skills/deco-v7-to-v8-migration/scripts.
const BLOCKS_PACKAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/blocks",
);

const quiet: Reporter & { text: string[] } = {
  text: [],
  info() {},
  warn(m) {
    quiet.text.push(m);
  },
  error(m) {
    quiet.text.push(m);
  },
};

function write(root: string, file: string, data: string | object) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
}

/** v7's secret format: AES-CBC under DECO_CRYPTO_KEY, base64 of `{ key, iv }`, hex output. */
async function v7CryptoKey() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const aes = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
  return {
    env: btoa(JSON.stringify({ key: [...key], iv: [...iv] })),
    encrypt: async (value: string) =>
      Buffer.from(
        await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aes, new TextEncoder().encode(value)),
      ).toString("hex"),
  };
}

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
    "base64",
  );
  return {
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString("base64")}\n-----END PUBLIC KEY-----\n`,
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
  };
}

let root: string;
let report: Report;
let privateKeyPem: string;
const savedEnv = process.env.DECO_CRYPTO_KEY;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-to-v8-")));
  fs.mkdirSync(path.join(root, "node_modules", "@decocms"), { recursive: true });
  fs.symlinkSync(BLOCKS_PACKAGE, path.join(root, "node_modules", "@decocms", "blocks"), "dir");
  write(root, "package.json", {
    name: "v7-site",
    private: true,
    type: "module",
    scripts: { dev: "vite dev" },
  });

  // A v7 app, installed: a loader that imports its own client relatively and its utils by name.
  const app = "node_modules/@decocms/apps-acme";
  write(root, `${app}/package.json`, {
    name: "@decocms/apps-acme",
    exports: {
      ".": "./src/index.ts",
      "./types": "./src/types.ts",
      "./utils/*": "./src/utils/*.ts",
      "./loaders/*": "./src/loaders/*.ts",
    },
  });
  write(root, `${app}/src/types.ts`, "export interface Item { sku: string; name: string }\n");
  write(
    root,
    `${app}/src/utils/limit.ts`,
    "export const clamp = (n: number) => Math.min(n, 50);\n",
  );
  write(
    root,
    `${app}/src/loaders/ItemList.ts`,
    [
      'import type { Item } from "../types";',
      'import { clamp } from "@decocms/apps-acme/utils/limit";',
      "export interface Props { query: string; count?: number }",
      "export default async function itemList(props: Props): Promise<Item[]> {",
      "  return Array.from({ length: clamp(props.count ?? 2) }, (_, i) => ({ sku: String(i), name: props.query }));",
      "}",
      "",
    ].join("\n"),
  );
  write(root, `${app}/src/loaders/Unused.ts`, "export default () => 1;\n");

  // The site: two sections, one with a v7 section loader.
  write(
    root,
    "src/sections/Hero.tsx",
    "export interface Props { title: string }\nexport default function Hero(props: Props) { return props.title; }\n",
  );
  write(
    root,
    "src/sections/Shelf.tsx",
    [
      'import type { Item } from "@decocms/apps-acme/types";',
      "export interface Props { title?: string; items: Item[] | null }",
      "export default function Shelf(props: Props) { return props.items?.length ?? 0; }",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/setup.ts",
    [
      'import { createInstrumentedFetch } from "@decocms/blocks/sdk/instrumentedFetch";',
      'import itemList from "@decocms/apps-acme/loaders/ItemList";',
      'import { createSiteSetup } from "@decocms/blocks/setup";',
      'import { createCMS } from "@decocms/blocks";',
      'export const fetcher = createInstrumentedFetch("acme");',
      "export { itemList, createSiteSetup, createCMS };",
      "",
    ].join("\n"),
  );

  // v7 content: a page with both sections, the shelf fed by the app loader, a
  // v7 secret, a Lazy wrapper (no v8 equivalent) and v7's generated files.
  const crypto7 = await v7CryptoKey();
  process.env.DECO_CRYPTO_KEY = crypto7.env;
  const keys = await keyPair();
  privateKeyPem = keys.privateKeyPem;
  write(root, ".deco/secrets.pub", keys.publicKeyPem);
  write(root, ".deco/blocks/pages-home.json", {
    __resolveType: "website/pages/Page.tsx",
    name: "Home",
    path: "/",
    sections: [
      { __resolveType: "site/sections/Hero.tsx", title: "Welcome" },
      {
        __resolveType: "site/sections/Shelf.tsx",
        items: { __resolveType: "acme/loaders/ItemList.ts", query: "shirt", count: 3 },
      },
    ],
  });
  write(root, ".deco/blocks/API_KEY.json", {
    __resolveType: "website/loaders/secret.ts",
    encrypted: await crypto7.encrypt("s3cret-value"),
    name: "ACME_API_KEY",
  });
  write(root, ".deco/blocks/Lazy%20Hero.json", {
    __resolveType: "website/sections/Rendering/Lazy.tsx",
    section: { __resolveType: "site/sections/Hero.tsx", title: "Later" },
  });
  write(root, ".deco/meta.gen.json", { v7: true });
  write(root, ".deco/sections.gen.ts", "export {};\n");

  report = await migrate({ root });
});

afterAll(() => {
  process.env.DECO_CRYPTO_KEY = savedEnv;
  if (savedEnv === undefined) delete process.env.DECO_CRYPTO_KEY;
  resetForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const manual = (step: string) =>
  report.manual.filter((n) => n.step === step).map((n) => `${n.subject}: ${n.message}`);

describe("migrate", () => {
  it("writes a block map with a short name and an alias under each v7 name", () => {
    const map = read(".deco/index.ts");
    expect(map).toContain('const hero = section<typeof import("../src/sections/Hero")>("hero");');
    expect(map).toContain('"hero": hero,\n  "site/sections/Hero.tsx": hero,');
    expect(map).toContain('import acmeItemList from "../src/vendor/acme/loaders/ItemList";');
    expect(map).toContain(
      '"acme-item-list": acmeItemList,\n  "acme/loaders/ItemList.ts": acmeItemList,',
    );
    // Built-ins and the runtime's legacy names need no entry.
    expect(map).not.toContain("website/pages/Page.tsx");
    expect(map).not.toContain("website/loaders/secret.ts");
  });

  it("vendors the loader the content calls, with the modules of its package it imports", () => {
    const copy = read("src/vendor/acme/loaders/ItemList.ts");
    expect(copy).toMatch(/^\/\/ Vendored from @decocms\/apps-acme \(loaders\/ItemList\.ts\)/);
    expect(copy).toContain('from "../utils/limit"');
    expect(copy).toContain('from "../types"');
    expect(fs.existsSync(path.join(root, "src/vendor/acme/utils/limit.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/vendor/acme/types.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/vendor/acme/loaders/Unused.ts"))).toBe(false);
  });

  it("reports a type with no v8 equivalent instead of registering it", () => {
    expect(read(".deco/index.ts")).not.toContain("Rendering/Lazy");
    expect(manual("block map").join("\n")).toContain(
      "website/sections/Rendering/Lazy.tsx (in Lazy%20Hero.json): v7's Lazy section wrapper",
    );
  });

  it("rewrites the imports that have a v8 equivalent and reports the rest", () => {
    const setup = read("src/setup.ts");
    expect(setup).toContain('import { createInstrumentedFetch } from "@decocms/blocks/fetch";');
    expect(setup).toContain('createInstrumentedFetch({ provider: "acme" })');
    expect(setup).toContain('import itemList from "./vendor/acme/loaders/ItemList";');
    expect(setup).toContain('import { createCMS } from "@decocms/blocks";');
    // The section's type now comes from the vendored copy, the same one the loader returns.
    expect(read("src/sections/Shelf.tsx")).toContain(
      'import type { Item } from "../vendor/acme/types";',
    );
    const imports = manual("imports").join("\n");
    expect(imports).toContain("@decocms/blocks/setup {createSiteSetup}: setup is createCMS");
    expect(imports).not.toContain("@decocms/blocks {");
  });

  it("removes v7 generated files and adds the deco scripts", () => {
    expect(fs.existsSync(path.join(root, ".deco/meta.gen.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".deco/sections.gen.ts"))).toBe(false);
    expect(JSON.parse(read("package.json")).scripts).toEqual({
      dev: "vite dev",
      predev: "deco schema && deco content",
      prebuild: "deco schema && deco content && deco check",
    });
  });

  it("re-encrypts the v7 secret with the site's public key", () => {
    const secret = JSON.parse(read(".deco/blocks/API_KEY.json"));
    expect(Object.keys(secret)).toEqual(["__resolveType", "ciphertext"]);
    expect(secret.__resolveType).toBe("secret");
    expect(read(".deco/blocks/API_KEY.json")).not.toContain("s3cret-value");
  });

  it("leaves a tree that passes deco schema, deco content and (after the reported fix) deco check", async () => {
    expect(await schema({ root, reporter: quiet })).toBe(0);
    expect(await content({ root, reporter: quiet })).toBe(0);
    // The one reported item: the Lazy wrapper has no block. Drop that entry, as a person would.
    expect(check({ root, reporter: quiet })).toBe(1);
    expect(quiet.text.join("\n")).toContain(
      'unknown block type "website/sections/Rendering/Lazy.tsx"',
    );
    fs.rmSync(path.join(root, ".deco/blocks/Lazy%20Hero.json"));
    quiet.text.length = 0;
    expect(check({ root, reporter: quiet })).toBe(0);
    expect(quiet.text).toEqual([]);
  });

  it("resolves the migrated content: v7 names through the aliases, the secret with the new key", async () => {
    await content({ root, reporter: quiet });
    const blocks = (await import(pathToFileURL(path.join(root, ".deco/index.ts")).href)).default;
    const snapshot = (await import(pathToFileURL(path.join(root, ".deco/blocks.gen.ts")).href))
      .default;
    const cms = createCMS({ blocks, content: snapshot, secrets: { key: privateKeyPem } });
    const client = cms.forRelease();
    const [page, error] = await client.resolve<any>("pages-home");
    expect(error).toBeNull();
    expect(page.sections).toEqual([
      { component: "hero", props: { title: "Welcome" } },
      {
        component: "shelf",
        props: {
          items: [
            { sku: "0", name: "shirt" },
            { sku: "1", name: "shirt" },
            { sku: "2", name: "shirt" },
          ],
        },
      },
    ]);
    expect(await client.resolve("API_KEY")).toEqual(["s3cret-value", null]);
  });

  it("keeps an existing block map and copies on a second run", async () => {
    const before = read(".deco/index.ts");
    const second = await migrate({ root });
    expect(read(".deco/index.ts")).toBe(before);
    expect(
      second.manual.some(
        (n) => n.subject === ".deco/index.ts" && n.message.startsWith("already exists"),
      ),
    ).toBe(true);
  });
});
