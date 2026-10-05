// @vitest-environment node
/**
 * Docs conformance, CLI side: the `.deco` folder, `deco schema`, `deco
 * content`, `deco check` and `deco serve` as blocks, saved-blocks,
 * built-in-blocks, lazy-blocks and matchers-and-variants describe them.
 * Fixture apps import from `@decocms/blocks` exactly as the docs' examples do.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSecretsKeyPair } from "../../protocol/__tests__/fixtures";
import { encryptToCiphertext } from "../../protocol/ciphertext";
import { createFixture, type Fixture, recorder } from "../cli/__tests__/fixture";
import { runCli } from "../cli/run";
import { toBase64 } from "../cli/schema/typeToSchema";
import { startServer } from "../cli/serve/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(here, "../../..");
const TEN = [
  "lazy",
  "multivariate",
  "always",
  "never",
  "date",
  "page",
  "redirect",
  "telemetry",
  "analytics",
  "secret",
];

/** The docs' app: block map, components, matchers, a newsletter with a Secret. */
const APP: Record<string, string> = {
  "src/promo-banner.tsx": `
export interface PromoBannerProps {
  title: string;
  href: string;
}

export function PromoBanner({ title, href }: PromoBannerProps) {
  return <a href={href}>{title}</a>;
}
`,
  "src/catalog-product.ts": `
export interface Product { name: string; slug: string }
export async function catalogProduct({ slug }: { slug: string }): Promise<Product> {
  return { name: slug, slug };
}
`,
  "src/product-card.tsx": `
import type { Lazy } from "@decocms/blocks";
import type { Product } from "./catalog-product";
export function productCard({ title, product }: { title: string; product: Product }) {
  return <div>{title}{product.name}</div>;
}
export async function lazyCard({ title, product }: { title: string; product: Lazy<Product> }) {
  return <div>{title}{(await product()).name}</div>;
}
`,
  "src/newsletter.tsx": `
import type { Secret } from "@decocms/blocks";

export interface NewsletterProps {
  listId: string;
  /** @title API key */
  apiKey: Secret;
}
export function Newsletter(props: NewsletterProps) {
  return <form data-list={props.listId} />;
}
`,
  "src/matchers.ts": `
type Day = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export function weekday({ days, timeZone = "America/New_York" }: { days: Day[]; timeZone?: string }) {
  const today = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date());   // "Sat"
  return days.some((day) => day === today);
}
`,
  "src/seo.ts": `
export default function seo(props: { title: string; description: string }) { return props; }
`,
  "src/hero.tsx": `
export default function hero(props: { title: string }) { return <section>{props.title}</section>; }
`,
  ".deco/index.ts": `
import type { Blocks, Page } from "@decocms/blocks";
import { catalogProduct } from "../src/catalog-product";
import { productCard, lazyCard } from "../src/product-card";
import { PromoBanner } from "../src/promo-banner";
import { Newsletter } from "../src/newsletter";
import { weekday } from "../src/matchers";
import seo from "../src/seo";
import hero from "../src/hero";

interface StorePage extends Page { theme: "light" | "dark" }

const page = (props: StorePage) => props;

export default {
  "catalog-product": catalogProduct,
  "product-card": productCard,
  "lazy-card": lazyCard,
  "promo-banner": PromoBanner,
  newsletter: Newsletter,
  weekday,
  seo,
  hero,
  page,
} satisfies Blocks;
`,
};

const summerCard = {
  __resolveType: "product-card",
  title: "Summer collection",
  product: { __resolveType: "catalog-product", slug: "summer-shirt" },
};

let app: Fixture;
let meta: any;
const def = (name: string) => meta.schema.definitions[toBase64(name)];

async function deco(args: string[], cwd: string) {
  const out = recorder();
  const code = await runCli(args, { cwd, reporter: out });
  return { code, out: out.text(), lines: out.lines };
}

beforeAll(async () => {
  app = createFixture({
    ...APP,
    ".deco/blocks/SummerCard.json": summerCard,
    ".deco/blocks/HomePage.json": {
      __resolveType: "page",
      name: "Home",
      path: "/",
      theme: "light",
      sections: [{ __resolveType: "SummerCard" }],
    },
  });
  const { code, out } = await deco(["schema"], app.root);
  expect(code, out).toBe(0);
  meta = JSON.parse(app.read(".deco/schema.gen.json"));
}, 120_000);
afterAll(() => app?.remove());

describe("the .deco folder", () => {
  it("saved-01: deco schema writes schema.gen.json, deco content writes blocks.gen.ts; the examples gitignore blocks.gen.ts", async () => {
    expect(app.exists(".deco/schema.gen.json")).toBe(true);
    const { code, out } = await deco(["content"], app.root);
    expect(code, out).toBe(0);
    expect(app.exists(".deco/blocks.gen.ts")).toBe(true);
    const repo = path.resolve(PACKAGE, "../..");
    for (const example of ["tanstack-smoke", "nextjs-smoke"]) {
      const ignored = (file: string) => {
        try {
          execFileSync("git", ["check-ignore", "-q", `examples/${example}/.deco/${file}`], {
            cwd: repo,
          });
          return true;
        } catch {
          return false;
        }
      };
      expect(ignored("blocks.gen.ts"), example).toBe(true);
      expect(ignored("schema.gen.json"), example).toBe(false);
    }
  });

  it("saved-02: every command walks up from the cwd to .deco, or takes --root", async () => {
    const nested = path.join(app.root, "src", "deep", "er");
    fs.mkdirSync(nested, { recursive: true });
    fs.rmSync(path.join(app.root, ".deco/blocks.gen.ts"), { force: true });
    expect((await deco(["content"], nested)).code).toBe(0);
    expect(app.exists(".deco/blocks.gen.ts")).toBe(true);
    fs.rmSync(path.join(app.root, ".deco/blocks.gen.ts"));
    expect((await deco(["content", "--root", app.root], path.parse(app.root).root)).code).toBe(0);
    expect(app.exists(".deco/blocks.gen.ts")).toBe(true);
    expect((await deco(["check"], nested)).code).toBe(0);
  });

  it("saved-03/saved-11: deco content bundles every file in .deco/blocks, named by its file name", async () => {
    await deco(["content"], app.root);
    const mod = await import(
      `${pathToFileURL(path.join(app.root, ".deco/blocks.gen.ts")).href}?t=${Date.now()}`
    );
    const snapshot = mod.default ?? mod;
    expect(Object.keys(snapshot.blocks).sort()).toEqual(["HomePage", "SummerCard"]);
    expect(snapshot.blocks.SummerCard).toEqual(summerCard);
  });

  it("blocks-10: the block map can be .deco/index.tsx", async () => {
    const tsx = createFixture({
      ...APP,
      ".deco/index.tsx": APP[".deco/index.ts"],
      ".deco/index.ts": "",
    });
    try {
      fs.rmSync(path.join(tsx.root, ".deco/index.ts"));
      const { code, out } = await deco(["schema"], tsx.root);
      expect(code, out).toBe(0);
      const tsxMeta = JSON.parse(tsx.read(".deco/schema.gen.json"));
      expect(tsxMeta.schema.definitions[toBase64("promo-banner")]).toBeDefined();
    } finally {
      tsx.remove();
    }
  }, 120_000);
});

describe("deco schema", () => {
  it("blocks-13/builtin-01: all ten built-ins are in the schema, even with an empty block map", async () => {
    const empty = createFixture({ ".deco/index.ts": "export default {};\n" });
    try {
      const { code, out } = await deco(["schema"], empty.root);
      expect(code, out).toBe(0);
      const emptyMeta = JSON.parse(empty.read(".deco/schema.gen.json"));
      for (const name of TEN) {
        expect(emptyMeta.schema.definitions[toBase64(name)], name).toBeDefined();
      }
    } finally {
      empty.remove();
    }
  }, 120_000);

  it("builtin-12: a Secret field is marked write-only secret (a password box in the editor)", () => {
    const props = JSON.stringify(meta.schema.definitions);
    expect(props).toContain('"title":"API key"');
    const apiKey = Object.values(meta.schema.definitions)
      .map((d: any) => d?.properties?.apiKey)
      .find(Boolean);
    expect(apiKey).toMatchObject({ format: "secret", writeOnly: true });
  });

  it("builtin-07: the redirect schema's status enum is 301, 302, 307, 308", () => {
    expect(JSON.stringify(def("redirect").properties.status)).toContain("[301,302,307,308]");
  });

  it("builtin-03/mv-12: multivariate's schema has an optional experiment string", () => {
    const mv = def("multivariate");
    expect(mv.properties.experiment).toMatchObject({ type: "string" });
    expect(mv.required ?? []).not.toContain("experiment");
  });

  it("builtin-25: a page declared in the block map gives every page a theme select", () => {
    const page = JSON.stringify(def("page"));
    expect(page).toMatch(/"enum":\["light","dark"\]|"enum":\["dark","light"\]/);
  });

  it("lazy-05: a Lazy<Product> field has the form of a Product (the lazy wrapper's value)", () => {
    const props = Object.values(meta.schema.definitions)
      .map((d: any) => d?.properties?.product)
      .filter(Boolean);
    const lazy = props.find((p: any) => p.properties?.__resolveType?.enum?.[0] === "lazy");
    const plain = props.find((p: any) => p.properties?.__resolveType?.enum?.[0] !== "lazy");
    expect(lazy).toBeDefined();
    const { title: _t1, ...lazyForm } = lazy.properties.value;
    const { title: _t2, ...plainForm } = plain;
    expect(lazyForm).toEqual(plainForm);
  });

  it("mv-04: boolean-returning functions are matchers, next to the built-in date", () => {
    expect(Object.keys(meta.manifest.blocks.matchers)).toEqual(
      expect.arrayContaining(["weekday", "date", "always", "never"]),
    );
  });

  it("mv-08: npx @decocms/blocks runs `deco` (the package's sole bin) and `schema` writes the schema", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    expect(pkg.bin).toEqual({ deco: "./bin/deco.js" });
    fs.rmSync(path.join(app.root, ".deco/schema.gen.json"));
    execFileSync(process.execPath, [path.join(PACKAGE, "bin/deco.js"), "schema"], {
      cwd: path.join(app.root, "src"),
      stdio: "pipe",
    });
    expect(app.exists(".deco/schema.gen.json")).toBe(true);
  }, 120_000);
});

describe("deco check", () => {
  /** Runs deco check on the app with these saved blocks added; returns its output. */
  async function checkWith(blocks: Record<string, unknown>) {
    const written = Object.entries(blocks).map(([name, block]) =>
      app.write(`.deco/blocks/${name}.json`, block as object),
    );
    try {
      return await deco(["check"], app.root);
    } finally {
      for (const file of written) fs.rmSync(file);
    }
  }

  it("passes the docs' content", async () => {
    const { code, out } = await deco(["check"], app.root);
    expect(code, out).toBe(0);
  });

  it("saved-10/res-03: a saved block named like a block type is an error", async () => {
    const { code, out } = await checkWith({ "promo-banner": { __resolveType: "always" } });
    expect(code).toBe(1);
    expect(out).toContain('saved block "promo-banner" has the name of a block type');
  });

  it("builtin-26: no saved block can take a built-in's name", async () => {
    for (const name of TEN) {
      const { code, out } = await checkWith({ [name]: { __resolveType: "always" } });
      expect(code, name).toBe(1);
      expect(out).toContain(`saved block "${name}" has the name of a built-in block`);
    }
  });

  it("builtin-23: needs no key: checks ciphertexts are well formed without decrypting", async () => {
    const { publicKeyPem } = await generateSecretsKeyPair(2048);
    const ciphertext = await encryptToCiphertext(publicKeyPem, "re_live_123");
    const good = await checkWith({
      Newsletter: {
        __resolveType: "newsletter",
        listId: "l",
        apiKey: { __resolveType: "secret", ciphertext },
      },
    });
    expect(good.code, good.out).toBe(0);
    const bad = await checkWith({
      Newsletter: {
        __resolveType: "newsletter",
        listId: "l",
        apiKey: { __resolveType: "secret", ciphertext: "v1.nope" },
      },
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("not a well-formed ciphertext");
  });

  it("builtin-20 (check side): plain text in a Secret field is an error", async () => {
    const { code, out } = await checkWith({
      Newsletter: { __resolveType: "newsletter", listId: "l", apiKey: "plaintext" },
    });
    expect(code).toBe(1);
    expect(out).toContain("Secret");
  });

  it("lazy-06: a Lazy<T> field without a lazy block, and a lazy block in a plain field, both fail", async () => {
    const product = { __resolveType: "catalog-product", slug: "s" };
    const unwrapped = await checkWith({ A: { __resolveType: "lazy-card", title: "t", product } });
    expect(unwrapped.code).toBe(1);
    expect(unwrapped.out).toContain("wrap the value in a lazy block");
    const misplaced = await checkWith({
      B: {
        __resolveType: "product-card",
        title: "t",
        product: { __resolveType: "lazy", value: product },
      },
    });
    expect(misplaced.code).toBe(1);
    expect(misplaced.out).toContain("a lazy block only fits a Lazy<T> field");
    const ok = await checkWith({
      C: {
        __resolveType: "lazy-card",
        title: "t",
        product: { __resolveType: "lazy", value: product },
      },
    });
    expect(ok.code, ok.out).toBe(0);
  });

  it("mv-03: a saved variant whose value lacks the lazy wrapper is flagged", async () => {
    const { code, out } = await checkWith({
      Banner: {
        __resolveType: "promo-banner",
        href: "/",
        title: {
          __resolveType: "multivariate",
          variants: [{ rule: { __resolveType: "always" }, value: "plain" }],
        },
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("a variant's value must be a lazy block");
  });

  it("mv-14: a variant after an always rule is a warning (exit 0)", async () => {
    const { code, lines } = await checkWith({
      Banner: {
        __resolveType: "promo-banner",
        href: "/",
        title: {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "always" }, value: { __resolveType: "lazy", value: "a" } },
            { rule: { __resolveType: "never" }, value: { __resolveType: "lazy", value: "b" } },
          ],
        },
      },
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.level === "warn" && l.message.includes("can never be picked"))).toBe(
      true,
    );
  });
});

describe("deco serve", () => {
  it("builtin-13: serves the committed .deco/secrets.pub to the site editor", async () => {
    const { publicKeyPem } = await generateSecretsKeyPair(2048);
    const site = createFixture({ ".deco/secrets.pub": publicKeyPem });
    fs.mkdirSync(path.join(site.root, ".git"));
    site.write(".deco/schema.gen.json", meta);
    const server = await startServer({
      cwd: site.root,
      port: 0,
      reporter: recorder(),
    });
    try {
      const body: any = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: server.port,
            method: "POST",
            path: "/rpc",
            headers: {
              host: `127.0.0.1:${server.port}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }));
      });
      expect(body.result.secrets).toEqual({ publicKey: publicKeyPem });
    } finally {
      await server.close();
      site.remove();
    }
  });
});
