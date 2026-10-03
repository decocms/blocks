// @vitest-environment node
/**
 * The legacy alias bridge (studio-compatibility.mdx#well-known-types-and-the-alias-table,
 * renames-and-migrations.mdx): v7 content resolves on v8 through the built-in
 * alias table, with no block-map entry for the well-known names.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockNameFromFile } from "../protocol/keys";
import { builtIns } from "./builtins/index";
import { LEGACY_ALIASES } from "./builtins/legacy";
import { createCMS, resetForTests } from "./cms";
import { matchRoute } from "./matchRoute";
import type { Block, Blocks, CMSError, LegacyRedirect, Redirect } from "./types";

beforeEach(() => resetForTests());

function client(
  blocks: Blocks,
  content: Record<string, unknown>,
  aliases?: Record<string, string>,
) {
  return createCMS({
    blocks,
    content: { revision: "rev-1", blocks: content, aliases },
  }).forRelease();
}

const hero = vi.fn((props: { title: string }) => ({ hero: props.title }));

describe("the built-in legacy alias table", () => {
  beforeEach(() => {
    hero.mockClear();
  });

  it("maps exactly the documented well-known names to built-ins", () => {
    expect(LEGACY_ALIASES).toEqual({
      "website/pages/Page.tsx": "page",
      "$live/pages/LivePage.tsx": "page",
      "website/flags/multivariate.ts": "multivariate",
      "website/flags/multivariate/section.ts": "multivariate",
      "website/flags/multivariate/image.ts": "multivariate",
      "website/flags/multivariate/message.ts": "multivariate",
      "website/flags/multivariate/page.ts": "multivariate",
      "$live/flags/multivariate.ts": "multivariate",
      "website/matchers/always.ts": "always",
      "$live/matchers/MatchAlways.ts": "always",
      "website/matchers/never.ts": "never",
      "website/matchers/date.ts": "date",
      "$live/matchers/MatchDate.ts": "date",
      "website/loaders/redirect.ts": "redirect",
      "website/loaders/secret.ts": "secret",
    });
    for (const target of Object.values(LEGACY_ALIASES)) expect(builtIns).toHaveProperty(target);
  });

  it("resolves legacy pages as the built-in page, and lists them under page", async () => {
    const c = client(
      { hero },
      {
        Home: {
          __resolveType: "website/pages/Page.tsx",
          name: "Home",
          path: "/",
          sections: [{ __resolveType: "hero", title: "Hi" }],
        },
        Old: { __resolveType: "$live/pages/LivePage.tsx", name: "Old", path: "/old", sections: [] },
      },
    );
    await expect(c.resolve("Home")).resolves.toEqual([
      { name: "Home", path: "/", sections: [{ hero: "Hi" }] },
      null,
    ]);
    const [pages] = await c.list<Block>("page");
    expect(pages?.map((p) => p.name)).toEqual(["Home", "Old"]);
  });

  it("wraps legacy variants in lazy, so only the chosen one runs", async () => {
    const c = client(
      { hero },
      {
        Banner: {
          __resolveType: "website/flags/multivariate.ts",
          variants: [
            {
              rule: { __resolveType: "website/matchers/never.ts" },
              value: { __resolveType: "hero", title: "A" },
            },
            {
              rule: { __resolveType: "website/matchers/always.ts" },
              value: { __resolveType: "hero", title: "B" },
            },
          ],
        },
      },
    );
    await expect(c.resolve("Banner")).resolves.toEqual([{ hero: "B" }, null]);
    expect(hero).toHaveBeenCalledTimes(1);
  });

  it("hides a block with the section variant and a never rule, without running it", async () => {
    const c = client(
      { hero },
      {
        Page: {
          __resolveType: "website/pages/Page.tsx",
          name: "P",
          path: "/p",
          sections: [
            {
              __resolveType: "website/flags/multivariate/section.ts",
              variants: [
                {
                  rule: { __resolveType: "website/matchers/never.ts" },
                  value: { __resolveType: "hero", title: "Hidden" },
                },
              ],
            },
            { __resolveType: "hero", title: "Shown" },
          ],
        },
      },
    );
    const [page] = await c.resolve<{ sections: unknown[] }>("Page");
    expect(page?.sections).toEqual([{ hero: "Shown" }]);
    expect(hero).toHaveBeenCalledTimes(1);
  });

  it("leaves a variant that already holds a lazy block as it is", async () => {
    const received: unknown[] = [];
    const c = client(
      {
        multivariate: (props: { variants: { value: unknown }[] }) =>
          received.push(...props.variants),
      },
      {},
    );
    await c.resolve({
      __resolveType: "website/flags/multivariate.ts",
      variants: [
        { rule: true, value: { __resolveType: "lazy", value: 1 } },
        { rule: true, value: 2 },
      ],
    });
    // Both reach a declared multivariate as Lazy<T> functions; neither is a lazy of a lazy.
    const values = await Promise.all(
      received.map((v) => (v as { value: () => Promise<unknown> }).value()),
    );
    expect(values).toEqual([1, 2]);
  });

  it("lists legacy nested redirects under redirect, and matchRoute serves them", async () => {
    const legacy: Block = {
      __resolveType: "website/loaders/redirect.ts",
      redirect: {
        from: "/campaigns/summer",
        to: "/summer",
        type: "temporary",
        discardQueryParameters: true,
      },
    };
    const flat: Block = { __resolveType: "redirect", from: "/old", to: "/new", permanent: true };
    const c = client({}, { Legacy: legacy, Flat: flat });
    const [redirects] = await c.list<Redirect | LegacyRedirect>("redirect");
    expect(redirects).toEqual([flat, legacy]);
    expect(
      matchRoute("https://x.test/campaigns/summer?utm=1", {
        routes: [],
        redirects: redirects as Redirect[],
      }),
    ).toEqual({
      kind: "redirect",
      location: "/summer",
      status: 307,
    });
    await expect(c.resolve("Legacy")).resolves.toEqual([{ redirect: legacy.redirect }, null]);
  });

  it("resolves website/loaders/secret.ts as secret: a v7 value fails with BLOCK_FAILED, not UNKNOWN_BLOCK", async () => {
    const [, error] = await client({}, {}).resolve({
      __resolveType: "website/loaders/secret.ts",
      encrypted: "00",
      name: "TOKEN",
    });
    expect(error?.code).toBe("BLOCK_FAILED");
  });

  it("gives way to the snapshot's alias table and to the block map", async () => {
    const page = { __resolveType: "website/pages/Page.tsx", name: "P", path: "/", sections: [] };
    const viaSnapshot = client(
      { storePage: () => "store page" },
      { P: page },
      {
        "website/pages/Page.tsx": "storePage",
      },
    );
    await expect(viaSnapshot.resolve("P")).resolves.toEqual(["store page", null]);
    resetForTests();
    const viaMap = client({ "website/pages/Page.tsx": () => "registered" }, { P: page });
    await expect(viaMap.resolve("P")).resolves.toEqual(["registered", null]);
  });

  it("wraps legacy multivariate values in lazy when the snapshot aliases it to a site function", async () => {
    const received: unknown[] = [];
    const c = client(
      {
        storeFlag: (props: { variants: { value: unknown }[] }) => {
          received.push(...props.variants.map((v) => v.value));
          return "flag";
        },
      },
      {
        Banner: {
          __resolveType: "website/flags/multivariate.ts",
          variants: [
            { rule: true, value: "a" },
            { rule: true, value: { __resolveType: "lazy", value: "b" } },
          ],
        },
      },
      { "website/flags/multivariate.ts": "storeFlag" },
    );
    await expect(c.resolve("Banner")).resolves.toEqual(["flag", null]);
    expect(received.every((v) => typeof v === "function")).toBe(true);
    const values = await Promise.all(received.map((v) => (v as () => Promise<unknown>)()));
    expect(values).toEqual(["a", "b"]);
  });

  it("returns legacy blocks as saved with { run: false }", async () => {
    const banner = {
      __resolveType: "website/flags/multivariate.ts",
      variants: [{ rule: { __resolveType: "website/matchers/always.ts" }, value: "x" }],
    };
    await expect(client({}, { Banner: banner }).resolve("Banner", { run: false })).resolves.toEqual(
      [banner, null],
    );
  });
});

// ---------------------------------------------------------------------------
// Real v7 content
// ---------------------------------------------------------------------------

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/v7");

/**
 * Saved blocks copied from two sites (a subset closed over references; the
 * Shopify app's credentials redacted), keyed by the protocol's file-name rule.
 */
function loadSite(site: string): Record<string, unknown> {
  const blocks: Record<string, unknown> = {};
  for (const file of readdirSync(join(fixtures, site))) {
    blocks[blockNameFromFile(file)] = JSON.parse(readFileSync(join(fixtures, site, file), "utf-8"));
  }
  return blocks;
}

function typesIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) typesIn(item, out);
  else if (value !== null && typeof value === "object") {
    const type = (value as Block).__resolveType;
    if (typeof type === "string") out.add(type);
    for (const child of Object.values(value)) typesIn(child, out);
  }
  return out;
}

/**
 * The site's own block map, stubbed: every type that is neither a saved
 * block, a built-in nor a legacy alias returns its props. These are the
 * names each site registers itself (its sections, app loaders, and the
 * legacy names the docs leave to the site).
 */
function siteBlocks(content: Record<string, unknown>): { blocks: Blocks; registered: string[] } {
  const registered = [...typesIn(Object.values(content))]
    .filter((t) => !(t in content) && !(t in builtIns) && !(t in LEGACY_ALIASES))
    .sort();
  return { blocks: Object.fromEntries(registered.map((t) => [t, (p: unknown) => p])), registered };
}

function errorsIn(results: [unknown, CMSError | null][]): CMSError[] {
  return results.flatMap(([, error]) => (error ? [error] : []));
}

describe("real v7 content", () => {
  for (const site of ["storefront-tanstack", "blog-tanstack"]) {
    it(`${site}: every saved block resolves with no UNKNOWN_BLOCK`, async () => {
      const content = loadSite(site);
      const { blocks, registered } = siteBlocks(content);
      // The bridge, not the site, covers the well-known names this content uses.
      expect(registered).not.toContain("website/pages/Page.tsx");
      expect(registered).not.toContain("website/loaders/secret.ts");

      const c = createCMS({ blocks, content: { revision: "v7", blocks: content } }).forRelease();
      const results = await Promise.all(Object.keys(content).map((name) => c.resolve(name)));
      const failures = errorsIn(results);
      expect(failures.filter((e) => e.code === "UNKNOWN_BLOCK")).toEqual([]);
      // The one expected failure: the Shopify app's v7 secret, not yet re-encrypted.
      expect(failures.map((e) => [e.code, e.path])).toEqual(
        site === "storefront-tanstack" ? [["BLOCK_FAILED", ["adminAccessToken"]]] : [],
      );

      const [pages] = await c.list<Block>("page");
      const legacyPages = Object.values(content).filter(
        (entry) => (entry as Block).__resolveType === "website/pages/Page.tsx",
      );
      expect(pages).toHaveLength(legacyPages.length);
      expect(pages!.length).toBeGreaterThan(0);
    });
  }

  it("routes the legacy pages with matchRoute", async () => {
    const content = loadSite("blog-tanstack");
    const c = createCMS({
      blocks: siteBlocks(content).blocks,
      content: { revision: "v7", blocks: content },
    }).forRelease();
    const [pages] = await c.list<Block & { name: string; path: string }>("page");
    const match = matchRoute("https://blog.test/web-performance-guide", { routes: pages! });
    expect(match).toMatchObject({
      kind: "match",
      entry: { name: "Blog Post" },
      params: { slug: "web-performance-guide" },
    });
  });

  it("names the legacy types this content uses that the docs leave to the site", () => {
    const content = { ...loadSite("storefront-tanstack"), ...loadSite("blog-tanstack") };
    const legacy = siteBlocks(content).registered.filter(
      (t) => t.startsWith("website/") || t.startsWith("commerce/sections/Seo") || t === "resolved",
    );
    expect(legacy).toEqual([
      "commerce/sections/Seo/SeoPDPV2.tsx",
      "commerce/sections/Seo/SeoPLPV2.tsx",
      "resolved",
      "website/functions/requestToParam.ts",
      "website/loaders/fonts/googleFonts.ts",
      "website/matchers/device.ts",
      "website/matchers/random.ts",
      "website/sections/Rendering/Lazy.tsx",
      "website/sections/Seo/SeoV2.tsx",
    ]);
  });
});
