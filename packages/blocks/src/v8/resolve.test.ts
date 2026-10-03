// @vitest-environment node
/**
 * client.resolve: the api-reference table, the lookup rule (blocks.mdx),
 * saved blocks (saved-blocks.mdx) and "The rule in full"
 * (how-resolution-works.mdx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Blocks, Snapshot } from "./types";

function client(blocks: Blocks = docsBlocks(), content: Snapshot = docsSnapshot()) {
  return createCMS({ blocks, content }).forRelease();
}

beforeEach(() => resetForTests());
afterEach(() => vi.restoreAllMocks());

describe("client.resolve — the api-reference table", () => {
  it('resolve("SummerSEO") runs the entry\'s function', async () => {
    const [value, error] = await client().resolve("SummerSEO");
    expect(error).toBeNull();
    expect(value).toEqual({ title: "Sunny!", description: "Light layers for long days." });
  });

  it('resolve("SummerSEO", { run: false }) returns the saved block, nothing run', async () => {
    const seo = vi.fn();
    const [value, error] = await client({ seo }).resolve("SummerSEO", { run: false });
    expect(error).toBeNull();
    expect(value).toEqual({
      __resolveType: "seo",
      title: "Sunny!",
      description: "Light layers for long days.",
    });
    expect(seo).not.toHaveBeenCalled();
  });

  it('resolve("SummerPage") returns the built-in page with seo and sections resolved', async () => {
    const [page, error] = await client().resolve("SummerPage");
    expect(error).toBeNull();
    expect(page).toEqual({
      name: "Summer campaign",
      path: "/summer",
      seo: { title: "Sunny!", description: "Light layers for long days." },
      sections: [
        {
          component: "hero",
          props: { title: "Summer starts here", image: "https://cdn.example.com/summer.jpg" },
        },
      ],
    });
  });

  it("resolves an inline block", async () => {
    const seo = vi.fn((props) => ({ ...props, ran: true }));
    const [value] = await client({ seo }).resolve({ __resolveType: "seo", title: "Sale" });
    expect(seo).toHaveBeenCalledWith({ title: "Sale" });
    expect(value).toEqual({ title: "Sale", ran: true });
  });

  it("resolves an array: one result per block, undefined left out", async () => {
    const blocks: Blocks = { ...docsBlocks(), nothing: () => undefined };
    const [value] = await client(blocks).resolve([
      { __resolveType: "promo-banner", title: "A", href: "/a" },
      { __resolveType: "nothing" },
      {
        __resolveType: "multivariate",
        variants: [
          { rule: { __resolveType: "never" }, value: { __resolveType: "lazy", value: 1 } },
        ],
      },
      { __resolveType: "promo-banner", title: "B", href: "/b" },
    ]);
    expect(value).toEqual([
      { component: "promo-banner", props: { title: "A", href: "/a" } },
      { component: "promo-banner", props: { title: "B", href: "/b" } },
    ]);
  });

  it("returns the same object when it contains no blocks", async () => {
    const target = { title: "Store", nested: { list: [1, "two", null] } };
    const [value, error] = await client().resolve(target);
    expect(error).toBeNull();
    expect(value).toBe(target);
  });

  it("returns literals as they are", async () => {
    const c = client();
    expect(await c.resolve(42)).toEqual([42, null]);
    expect(await c.resolve(null)).toEqual([null, null]);
    expect(await c.resolve(true)).toEqual([true, null]);
  });

  it("walks any value, resolving blocks wherever they are", async () => {
    const [value] = await client().resolve({
      heading: "Deals",
      cards: [{ __resolveType: "SummerCard" }],
      meta: { seo: { __resolveType: "SummerSEO" } },
    });
    expect(value).toEqual({
      heading: "Deals",
      cards: [
        {
          component: "product-card",
          props: {
            title: "Summer collection",
            product: { name: "Summer shirt", slug: "summer-shirt" },
          },
        },
      ],
      meta: { seo: { title: "Sunny!", description: "Light layers for long days." } },
    });
  });
});

describe("composing blocks — inside out", () => {
  it("runs inner blocks first and passes their results, never a pending call", async () => {
    const order: string[] = [];
    const blocks: Blocks = {
      "catalog-product": async ({ slug }: { slug: string }) => {
        order.push("catalog-product");
        await Promise.resolve();
        return { name: "Summer shirt", slug };
      },
      "product-card": (props: { product: unknown }) => {
        order.push("product-card");
        expect(props.product).toEqual({ name: "Summer shirt", slug: "summer-shirt" });
        return props;
      },
    };
    const [card, error] = await client(blocks).resolve({
      __resolveType: "product-card",
      title: "Summer collection",
      product: { __resolveType: "catalog-product", slug: "summer-shirt" },
    });
    expect(error).toBeNull();
    expect(order).toEqual(["catalog-product", "product-card"]);
    expect(card).toEqual({
      title: "Summer collection",
      product: { name: "Summer shirt", slug: "summer-shirt" },
    });
  });

  it("resolves sibling inputs concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async ({ id }: { id: number }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return id;
    };
    const [value] = await client({ slow, list: (p: unknown) => p }).resolve({
      __resolveType: "list",
      a: { __resolveType: "slow", id: 1 },
      b: { __resolveType: "slow", id: 2 },
      c: [
        { __resolveType: "slow", id: 3 },
        { __resolveType: "slow", id: 4 },
      ],
    });
    expect(value).toEqual({ a: 1, b: 2, c: [3, 4] });
    expect(peak).toBe(4);
  });

  it("strips __resolveType before the call and never walks a function's result", async () => {
    const echo = vi.fn((props: unknown) => ({ ...(props as object), __resolveType: "echo" }));
    const [value, error] = await client({ echo }).resolve({ __resolveType: "echo", x: 1 });
    expect(error).toBeNull();
    expect(echo).toHaveBeenCalledTimes(1);
    expect(echo).toHaveBeenCalledWith({ x: 1 });
    expect(value).toEqual({ x: 1, __resolveType: "echo" });
  });

  it("returns a function's result as is, even when it contains blocks", async () => {
    const returnsBlock = () => ({ __resolveType: "SummerSEO" });
    const [value] = await client({ returnsBlock }).resolve({ __resolveType: "returnsBlock" });
    expect(value).toEqual({ __resolveType: "SummerSEO" });
  });

  it("awaits async functions", async () => {
    const [value] = await client({ later: async () => "done" }).resolve({ __resolveType: "later" });
    expect(value).toBe("done");
  });
});

describe("the lookup rule — { ...savedBlocks, ...builtIns, ...blocks }", () => {
  it("calls a function from the block map with its resolved arguments", async () => {
    const [value] = await client().resolve({
      __resolveType: "promo-banner",
      title: "Free shipping over $50",
      href: "/summer",
    });
    expect(value).toEqual({
      component: "promo-banner",
      props: { title: "Free shipping over $50", href: "/summer" },
    });
  });

  it("replaces a saved block by its contents and looks the result up again", async () => {
    const [value] = await client().resolve({ __resolveType: "SummerCard" });
    expect(value).toEqual({
      component: "product-card",
      props: {
        title: "Summer collection",
        product: { name: "Summer shirt", slug: "summer-shirt" },
      },
    });
  });

  it("fails any other name with UNKNOWN_BLOCK and the path where it happened", async () => {
    const [value, error] = await client().resolve({
      __resolveType: "page",
      name: "X",
      path: "/x",
      sections: [
        { __resolveType: "hero", title: "ok" },
        { __resolveType: "promo-banner", title: "ok", href: "/" },
        { __resolveType: "product-card", title: "t", product: { __resolveType: "missing-type" } },
      ],
    });
    expect(value).toBeNull();
    expect(error).toMatchObject({ code: "UNKNOWN_BLOCK", path: ["sections", 2, "product"] });
    expect(error?.message).toContain("missing-type");
  });

  it("never fails a built-in with UNKNOWN_BLOCK, even with an empty block map", async () => {
    const c = client({});
    for (const type of [
      "always",
      "never",
      "date",
      "page",
      "redirect",
      "telemetry",
      "analytics",
      "multivariate",
      "lazy",
    ]) {
      const [, error] = await c.resolve({ __resolveType: type });
      expect(error, type).toBeNull();
    }
  });

  it("a key in the block map overrides a built-in", async () => {
    const always = vi.fn(() => "mine");
    const [value] = await client({ always }).resolve({ __resolveType: "always" });
    expect(value).toBe("mine");
  });

  it("a function wins over a saved block of the same name, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = docsSnapshot();
    content.blocks.seo = { __resolveType: "hero", title: "saved block named seo" };
    const c = client(docsBlocks(), content);
    const [first] = await c.resolve({ __resolveType: "seo", title: "t", description: "d" });
    await c.resolve({ __resolveType: "seo", title: "u", description: "d" });
    expect(first).toEqual({ title: "t", description: "d" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"seo"');
  });

  it("warns when a saved block takes a reserved built-in name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = docsSnapshot();
    content.blocks.page = { __resolveType: "hero", title: "not a page" };
    const [value] = await client(docsBlocks(), content).resolve({
      __resolveType: "page",
      name: "n",
      path: "/",
      sections: [],
    });
    expect(value).toEqual({ name: "n", path: "/", sections: [] });
    expect(warn).toHaveBeenCalled();
  });

  it("a string target is always a saved block's name, never a block type", async () => {
    const [value, error] = await client().resolve("seo");
    expect(value).toBeNull();
    expect(error).toMatchObject({ code: "NOT_FOUND", path: [] });
  });

  it("ignores the prototype chain when looking names up", async () => {
    const [, e1] = await client().resolve({ __resolveType: "constructor" });
    const [, e2] = await client().resolve("toString");
    expect(e1?.code).toBe("UNKNOWN_BLOCK");
    expect(e2?.code).toBe("NOT_FOUND");
  });
});

describe("saved blocks — override arguments", () => {
  it("merges { ...saved, ...arguments } for one use, leaving the saved block unchanged", async () => {
    const content = docsSnapshot();
    const c = client(docsBlocks(), content);
    const [value] = await c.resolve({ __resolveType: "SummerSEO", title: "Summer sale" });
    expect(value).toEqual({ title: "Summer sale", description: "Light layers for long days." });
    expect(content.blocks.SummerSEO).toEqual({
      __resolveType: "seo",
      title: "Sunny!",
      description: "Light layers for long days.",
    });
    const [again] = await c.resolve("SummerSEO");
    expect(again).toEqual({ title: "Sunny!", description: "Light layers for long days." });
  });

  it("is shallow: an override replaces a whole top-level property", async () => {
    const content = docsSnapshot();
    content.blocks.Card = {
      __resolveType: "product-card",
      title: "t",
      product: { name: "a", tags: ["x", "y"] },
    };
    const [value] = await client(docsBlocks(), content).resolve({
      __resolveType: "Card",
      product: { name: "b" },
    });
    expect(value).toEqual({
      component: "product-card",
      props: { title: "t", product: { name: "b" } },
    });
  });

  it("looks the merged block up again, through chains of saved blocks", async () => {
    const content = docsSnapshot();
    content.blocks.SaleSEO = { __resolveType: "SummerSEO", title: "Sale" };
    content.blocks.FinalSEO = { __resolveType: "SaleSEO", description: "Final" };
    const [value] = await client(docsBlocks(), content).resolve("FinalSEO");
    expect(value).toEqual({ title: "Sale", description: "Final" });
  });

  it("expands a saved literal (not a block) to its value", async () => {
    const content = docsSnapshot();
    content.blocks.Headline = "Free shipping over $50";
    const [value] = await client(docsBlocks(), content).resolve({
      __resolveType: "promo-banner",
      title: { __resolveType: "Headline" },
      href: "/",
    });
    expect(value).toEqual({
      component: "promo-banner",
      props: { title: "Free shipping over $50", href: "/" },
    });
  });
});

describe("errors — the rule in full", () => {
  it("NOT_FOUND: a string target names no saved block", async () => {
    const [value, error] = await client().resolve("Nope");
    expect(value).toBeNull();
    expect(error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("CYCLE: an entry that references itself, with the chain in error.path", async () => {
    const content = docsSnapshot();
    content.blocks.Loop = { __resolveType: "Loop" };
    const [, error] = await client(docsBlocks(), content).resolve("Loop");
    expect(error).toMatchObject({ code: "CYCLE", path: ["Loop", "Loop"] });
  });

  it("CYCLE: two entries that reference each other", async () => {
    const content = docsSnapshot();
    content.blocks.A = { __resolveType: "hero", title: { __resolveType: "B" } };
    content.blocks.B = {
      __resolveType: "product-card",
      title: "b",
      product: { __resolveType: "A" },
    };
    const [, error] = await client(docsBlocks(), content).resolve({ __resolveType: "A" });
    expect(error).toMatchObject({ code: "CYCLE", path: ["A", "B", "A"] });
  });

  it("an entry reused on separate branches is not a cycle", async () => {
    const [value, error] = await client().resolve([
      { __resolveType: "SummerSEO" },
      { __resolveType: "SummerSEO" },
    ]);
    expect(error).toBeNull();
    expect(value).toHaveLength(2);
  });

  it("BLOCK_FAILED: a function threw; the original error is in cause", async () => {
    const boom = new Error("upstream down");
    const blocks: Blocks = {
      ...docsBlocks(),
      "catalog-product": () => {
        throw boom;
      },
    };
    const [value, error] = await client(blocks).resolve("SummerCard");
    expect(value).toBeNull();
    expect(error).toMatchObject({ code: "BLOCK_FAILED", path: ["product"], cause: boom });
    expect(error?.message).toContain("upstream down");
  });

  it("a failure stops the parent: it never runs", async () => {
    const card = vi.fn();
    const blocks: Blocks = {
      "product-card": card,
      "catalog-product": async () => {
        throw new Error("nope");
      },
    };
    const [, error] = await client(blocks).resolve({
      __resolveType: "product-card",
      product: { __resolveType: "catalog-product" },
    });
    expect(error?.code).toBe("BLOCK_FAILED");
    expect(card).not.toHaveBeenCalled();
  });

  it("a failing block is isolated to its result: it never throws, and other clients are unaffected", async () => {
    let fail = true;
    const flaky = () => {
      if (fail) throw new Error("flaky");
      return "ok";
    };
    const cms = createCMS({ blocks: { flaky }, content: docsSnapshot() });
    const target = { __resolveType: "flaky" };
    await expect(cms.forRelease().resolve(target)).resolves.toMatchObject([
      null,
      { code: "BLOCK_FAILED" },
    ]);
    fail = false;
    await expect(cms.forRelease().resolve(target)).resolves.toEqual(["ok", null]);
  });

  it("a block function can legitimately return null", async () => {
    const [value, error] = await client({ nil: () => null }).resolve({ __resolveType: "nil" });
    expect(value).toBeNull();
    expect(error).toBeNull();
  });

  it("errors carry the documented shape", async () => {
    const [, error] = await client().resolve({ __resolveType: "nope" });
    expect(error).toEqual(
      expect.objectContaining({ code: "UNKNOWN_BLOCK", message: expect.any(String), path: [] }),
    );
  });
});

describe("reading without running — { run: false }", () => {
  it("expands references everywhere, merges overrides, runs nothing", async () => {
    const spies = Object.fromEntries(
      Object.keys(docsBlocks()).map((key) => [key, vi.fn()]),
    ) as Blocks;
    const [value, error] = await client(spies).resolve("HomePage", { run: false });
    expect(error).toBeNull();
    expect(value).toEqual({
      __resolveType: "page",
      name: "Home",
      path: "/",
      sections: [
        {
          __resolveType: "product-card",
          title: "Summer collection",
          product: { __resolveType: "catalog-product", slug: "summer-shirt" },
        },
      ],
    });
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps lazy blocks and unknown types as saved", async () => {
    const target = {
      __resolveType: "product-card",
      product: { __resolveType: "lazy", value: { __resolveType: "CurrentProduct" } },
      other: { __resolveType: "unknown-type", x: 1 },
    };
    const [value, error] = await client().resolve(target, { run: false });
    expect(error).toBeNull();
    expect(value).toEqual({
      __resolveType: "product-card",
      product: {
        __resolveType: "lazy",
        value: { __resolveType: "catalog-product", slug: "summer-shirt" },
      },
      other: { __resolveType: "unknown-type", x: 1 },
    });
  });

  it("still detects cycles", async () => {
    const content = docsSnapshot();
    content.blocks.Loop = { __resolveType: "Loop" };
    const [, error] = await client(docsBlocks(), content).resolve("Loop", { run: false });
    expect(error?.code).toBe("CYCLE");
  });

  it("returns a target with no saved references as the same object", async () => {
    const target = { __resolveType: "seo", title: "x" };
    const [value] = await client().resolve(target, { run: false });
    expect(value).toBe(target);
  });
});

describe("shared content is never mutated", () => {
  it("hands block functions fresh inputs and callers fresh copies of saved JSON", async () => {
    const content = docsSnapshot();
    content.blocks.Shelf = { __resolveType: "shelf", items: [{ id: 1 }], meta: { tags: ["a"] } };
    const frozen = JSON.stringify(content.blocks);
    const shelf = (props: { items: { id: number }[]; meta: { tags: string[] } }) => {
      props.items.push({ id: 2 });
      props.meta.tags.push("mutated");
      return props;
    };
    const cms = createCMS({ blocks: { ...docsBlocks(), shelf }, content });
    await cms.forRelease().resolve("Shelf");
    const [expanded] = await cms
      .forRelease()
      .resolve<{ items: unknown[] }>("Shelf", { run: false });
    expanded?.items.push("caller mutation");
    const [listed] = await cms.forRelease().list<{ items: unknown[] }>("shelf");
    listed?.[0]?.items.push("caller mutation");
    expect(JSON.stringify(content.blocks)).toBe(frozen);
  });
});

describe("aliases — the snapshot's alias table", () => {
  it("resolves an old type name through the alias table", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {},
      aliases: { "website/sections/Hero.tsx": "hero" },
    };
    const [value] = await client(docsBlocks(), content).resolve({
      __resolveType: "website/sections/Hero.tsx",
      title: "Old name",
    });
    expect(value).toEqual({ component: "hero", props: { title: "Old name" } });
  });

  it("maps legacy page names to the built-in page", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {},
      aliases: { "website/pages/Page.tsx": "page" },
    };
    const [value] = await client({}, content).resolve({
      __resolveType: "website/pages/Page.tsx",
      name: "Legacy",
      path: "/legacy",
      sections: [],
    });
    expect(value).toEqual({ name: "Legacy", path: "/legacy", sections: [] });
  });

  it("follows one alias hop only, so an alias loop is UNKNOWN_BLOCK, not a hang", async () => {
    const content: Snapshot = { revision: "r", blocks: {}, aliases: { a: "b", b: "a" } };
    const [, error] = await client({}, content).resolve({ __resolveType: "a" });
    expect(error?.code).toBe("UNKNOWN_BLOCK");
  });
});
