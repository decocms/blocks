// @vitest-environment node
/**
 * End to end: a small v7 site (sections, an app loader its content calls, a
 * v7 secret, v7 async-rendering wrappers) goes through `migrate`, then
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
  fs.symlinkSync(
    path.join(BLOCKS_PACKAGE, "../compat-v7"),
    path.join(root, "node_modules", "@decocms", "compat-v7"),
    "dir",
  );
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
  // A section whose loader reads v7's ctx.device, and v7's registration of the loaders.
  write(
    root,
    "src/sections/Promo.tsx",
    [
      "export interface Props { label: string; device?: string }",
      'export function loader(props: Props, _req: Request, ctx: { device: "mobile" | "tablet" | "desktop" }) {',
      "  return { ...props, device: ctx.device };",
      "}",
      'export default function Promo(props: Props) { return [props.label, props.device].join(" "); }',
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/setup/section-loaders.ts",
    [
      "import {",
      "  compose,",
      "  registerNonCriticalSections,",
      "  registerSectionLoaders,",
      "  withDevice,",
      "  withSearchParam,",
      "  withSectionLoader,",
      '} from "@decocms/blocks/cms";',
      "",
      "registerSectionLoaders({",
      '  "site/sections/Hero.tsx": compose(withDevice(), withSearchParam()),',
      '  "site/sections/Promo.tsx": withSectionLoader(() => import("../sections/Promo")),',
      "});",
      'registerNonCriticalSections(["site/sections/Promo.tsx"]);',
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
  // v7 secret, Lazy wrappers (no async rendering in v8) and v7's generated files.
  const crypto7 = await v7CryptoKey();
  process.env.DECO_CRYPTO_KEY = crypto7.env;
  const keys = await keyPair();
  privateKeyPem = keys.privateKeyPem;
  write(root, ".deco/secrets.pub", keys.publicKeyPem);
  // v7's extra preview hosts: Studio knows the site's addresses now, so the migration drops them
  // silently (the Site block's previewHosts: steps.test.ts).
  write(root, ".env", "DECO_ALLOWED_PREVIEW_HOSTS=staging.example.com\n");
  write(root, ".deco/blocks/pages-home.json", {
    __resolveType: "website/pages/Page.tsx",
    name: "Home",
    path: "/",
    sections: [
      { __resolveType: "site/sections/Hero.tsx", title: "Welcome" },
      { __resolveType: "site/sections/Promo.tsx", label: "Sale" },
      {
        __resolveType: "website/sections/Rendering/Lazy.tsx",
        section: {
          __resolveType: "site/sections/Shelf.tsx",
          items: { __resolveType: "acme/loaders/ItemList.ts", query: "shirt", count: 3 },
        },
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
  // A prerelease next-major settings block: deco check fails on it until it's folded.
  write(root, ".deco/blocks/Telemetry.json", { __resolveType: "telemetry", errorSampleRate: 0.01 });
  write(root, ".deco/meta.gen.json", { v7: true });
  write(root, ".deco/sections.gen.ts", "export {};\n");
  // The site's repository and its pull-request CI, which gets `deco schema --check`.
  fs.mkdirSync(path.join(root, ".git"));
  write(root, "bun.lock", "");
  write(
    root,
    ".github/workflows/ci.yml",
    "on: pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: bun install\n      - run: bun run build\n",
  );

  report = await migrate({ root });
});

afterAll(() => {
  process.env.DECO_CRYPTO_KEY = savedEnv;
  if (savedEnv === undefined) delete process.env.DECO_CRYPTO_KEY;
  resetForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

/** The home page's sections as the migrated block map resolves them: descriptors with saved props. */
const SECTIONS = [
  { component: "site/sections/Hero.tsx", props: { title: "Welcome" } },
  { component: "site/sections/Promo.tsx", props: { label: "Sale" } },
  {
    component: "site/sections/Shelf.tsx",
    props: {
      items: [
        { sku: "0", name: "shirt" },
        { sku: "1", name: "shirt" },
        { sku: "2", name: "shirt" },
      ],
    },
  },
];
const manual = (step: string) =>
  report.manual.filter((n) => n.step === step).map((n) => `${n.subject}: ${n.message}`);

describe("migrate", () => {
  it("writes a block map under the v7 names only, so the site editor lists each block once", () => {
    const map = read(".deco/index.ts");
    // A descriptor's component is the section's v7 type name: v7's section loaders and the
    // view registry are keyed on it.
    expect(map).toContain(
      'const hero = section<typeof import("../src/sections/Hero")>("site/sections/Hero.tsx");',
    );
    expect(map).toContain('\n  "site/sections/Hero.tsx": hero,');
    expect(map).not.toContain('"hero":');
    expect(map).toContain('import acmeItemList from "../src/vendor/acme/loaders/ItemList";');
    expect(map).toContain('\n  "acme/loaders/ItemList.ts": acmeItemList,');
    expect(map).not.toContain('"acme-item-list":');
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

  it("unwraps v7 Lazy wrappers to the section they held, in pages and saved blocks", () => {
    expect(read(".deco/index.ts")).not.toContain("Rendering/");
    expect(JSON.parse(read(".deco/blocks/Lazy%20Hero.json"))).toEqual({
      __resolveType: "site/sections/Hero.tsx",
      title: "Later",
    });
    expect(JSON.parse(read(".deco/blocks/pages-home.json")).sections[2]).toEqual({
      __resolveType: "site/sections/Shelf.tsx",
      items: { __resolveType: "acme/loaders/ItemList.ts", query: "shirt", count: 3 },
    });
    expect(manual("block map").join("\n")).not.toContain("Rendering/");
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

  it("adds deco schema --check to the site's pull-request CI, after the install (PO 2026-10-15)", () => {
    expect(read(".github/workflows/ci.yml")).toContain(
      "      - run: bun install\n      - name: Check that .deco/schema.gen.json is up to date\n        run: bunx deco schema --check\n      - run: bun run build\n",
    );
    expect(report.done.find((n) => n.subject === "CI")?.message).toContain(
      ".github/workflows/ci.yml",
    );
  });

  it("re-encrypts the v7 secret with the site's public key", () => {
    const secret = JSON.parse(read(".deco/blocks/API_KEY.json"));
    expect(Object.keys(secret)).toEqual(["__resolveType", "ciphertext"]);
    expect(secret.__resolveType).toBe("secret");
    expect(read(".deco/blocks/API_KEY.json")).not.toContain("s3cret-value");
  });

  it("folds settings into the CMS block and deletes the prerelease block", () => {
    expect(fs.existsSync(path.join(root, ".deco/blocks/Telemetry.json"))).toBe(false);
    expect(JSON.parse(read(".deco/blocks/CMS.json"))).toEqual({
      __resolveType: "cms-settings",
      telemetry: { errorSampleRate: 0.01 },
    });
    expect(manual("settings").join("\n")).toContain("DECO_OTEL_* sampling");
    expect(manual("settings").join("\n")).not.toMatch(/preview/i);
  });

  it("drops v7's extra preview hosts silently: nothing in the report names them", () => {
    expect(JSON.stringify(report)).not.toMatch(
      /preview ?hosts|PREVIEW_HOSTS|staging\.example\.com/i,
    );
  });

  it("leaves a tree that passes deco schema, deco content and deco check", async () => {
    expect(await schema({ root, reporter: quiet })).toBe(0);
    expect(await content({ root, reporter: quiet })).toBe(0);
    expect(check({ root, reporter: quiet })).toBe(0);
    // Nothing to warn about: preview hosts are Studio's, not the site's.
    expect(quiet.text).toEqual([]);
    expect(report.manual.some((n) => /preview host/i.test(n.subject))).toBe(false);
    // deco schema runs the TypeScript compiler: seconds on a loaded machine.
  }, 30_000);

  it("resolves the migrated content: v7 names through the aliases, the secret with the new key", async () => {
    await content({ root, reporter: quiet });
    const blocks = (await import(pathToFileURL(path.join(root, ".deco/index.ts")).href)).default;
    const snapshot = (await import(pathToFileURL(path.join(root, ".deco/blocks.gen.ts")).href))
      .default;
    const cms = createCMS({ blocks, content: snapshot, secrets: { key: privateKeyPem } });
    const client = cms.forRelease();
    const [page, error] = await client.resolve<any>("pages-home");
    expect(error).toBeNull();
    expect(page.sections).toEqual(SECTIONS);
    expect(await client.resolve("API_KEY")).toEqual(["s3cret-value", null]);
  });

  it("writes the view registry: each section's module by its v7 type name", () => {
    expect(read("src/views.ts")).toContain('import * as hero from "./sections/Hero";');
    expect(read("src/views.ts")).toContain('  "site/sections/Promo.tsx": promo,');
    expect(report.done.some((n) => n.subject === "src/views.ts")).toBe(true);
  });

  it("runs v7's registered section loaders through loadSections, ctx.device read from the request", async () => {
    // v7's registration is now an export of the same map; its mixins come from @decocms/compat-v7.
    const loaders = read("src/setup/section-loaders.ts");
    expect(loaders).toContain(
      'export const sectionLoaders: RunSectionLoadersOptions["loaders"] = {',
    );
    expect(loaders).toContain(
      'export const nonCriticalSections: readonly string[] = ["site/sections/Promo.tsx"];',
    );
    expect(loaders).toContain(
      'import { compose, withDevice, withSearchParam, withSectionLoader } from "@decocms/compat-v7/sections";',
    );
    expect(loaders).not.toContain("@decocms/blocks/cms");
    expect(read("src/sections/Promo.tsx")).toContain(
      'device: detectDevice(_req.headers.get("user-agent") ?? "")',
    );
    expect(read("src/sections/Promo.tsx")).toContain(
      'import { detectDevice } from "@decocms/compat-v7/device";',
    );
    // Only the loader v7 never ran (none here) would be reported.
    expect(manual("block map").join("\n")).not.toContain("which v7 never ran");

    const map = await import(pathToFileURL(path.join(root, ".deco/index.ts")).href);
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    const request = new Request("https://shop.test/_serverFn/abc", {
      headers: { "user-agent": iphone },
    });
    const { sections, degraded } = await map.loadSections(
      SECTIONS,
      request,
      "https://shop.test/?q=boots",
    );
    expect(degraded).toEqual([]);
    const page = { __pageUrl: "https://shop.test/?q=boots", __pagePath: "/" };
    expect(sections[0]).toEqual({
      component: "site/sections/Hero.tsx",
      props: { title: "Welcome", ...page, device: "mobile", currentSearchParam: "boots" },
    });
    expect(sections[1]).toEqual({
      component: "site/sections/Promo.tsx",
      props: { label: "Sale", ...page, device: "mobile" },
    });
    expect(sections[2]).toEqual(SECTIONS[2]);
  });

  it("keeps an existing block map and copies on a second run", async () => {
    const before = read(".deco/index.ts");
    const settings = read(".deco/blocks/CMS.json");
    const second = await migrate({ root });
    expect(read(".deco/index.ts")).toBe(before);
    expect(read(".deco/blocks/CMS.json")).toBe(settings);
    expect(second.done.filter((n) => n.step === "settings")).toEqual([]);
    expect(
      second.manual.some(
        (n) => n.subject === ".deco/index.ts" && n.message.startsWith("already exists"),
      ),
    ).toBe(true);
  });
});
