// @vitest-environment node
/**
 * Docs conformance: blocks, saved-blocks, built-in-blocks, lazy-blocks,
 * how-resolution-works and matchers-and-variants (/next/*). Each test names
 * the claim it checks. Examples are run as the docs write them, through the
 * package's public entry points.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type {
  Block,
  Blocks,
  CMSError,
  Lazy,
  Page,
  Result,
  Route,
  Secret,
  Seo,
} from "@decocms/blocks";
import * as root from "@decocms/blocks";
import { createCMS, resetForTests } from "@decocms/blocks";
import { encryptSecret } from "@decocms/blocks/secrets";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { checkSecrets } from "../../protocol/secrets";
import { HOSTED_ANALYTICS_COLLECTOR } from "../builtins/data";
import { builtIns } from "../builtins/index";
import {
  and,
  blockMap,
  bucket,
  catalogCalls,
  catalogProduct,
  lazyProductCard,
  newsletter,
  not,
  PromoBanner,
  productCard,
  split,
  storeBlockMap,
  visitor,
  type weekday,
  weekdayBlockMap,
} from "./syntaxExamples";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILT_INS = [
  "lazy",
  "multivariate",
  "always",
  "never",
  "date",
  "page",
  "redirect",
  "cms-settings",
  "secret",
];

beforeEach(() => {
  resetForTests();
  catalogCalls.count = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let revisions = 0;
function cmsWith(blocks: Blocks, saved: Record<string, unknown> = {}, key?: string) {
  return createCMS({
    blocks,
    content: { revision: `rev-${++revisions}`, blocks: saved },
    ...(key === undefined ? {} : { secrets: { key } }),
  });
}
const clientWith = (blocks: Blocks, saved: Record<string, unknown> = {}) =>
  cmsWith(blocks, saved).forRelease();

const summerCardJson = {
  __resolveType: "product-card",
  title: "Summer collection",
  product: { __resolveType: "catalog-product", slug: "summer-shirt" },
};

/** Runs a promise-returning factory and records when each call starts and ends. */
function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
}

// ===========================================================================
// blocks.mdx
// ===========================================================================

describe("blocks", () => {
  it("blocks-01: a block is __resolveType plus arguments; it resolves to the function's result", async () => {
    const fn = vi.fn((props: { title: string; href: string }) => ({ out: props }));
    const [value, error] = await clientWith({ "promo-banner": fn }).resolve({
      __resolveType: "promo-banner",
      title: "Free shipping over $50",
      href: "/summer",
    });
    expect(error).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toEqual({ title: "Free shipping over $50", href: "/summer" });
    expect(value).toBe(fn.mock.results[0].value);
  });

  it("blocks-02: the PromoBanner component works as the promo-banner block", async () => {
    const [value, error] = await clientWith(blockMap).resolve({
      __resolveType: "promo-banner",
      title: "Free shipping over $50",
      href: "/summer",
    });
    expect(error).toBeNull();
    expect(isValidElement(value)).toBe(true);
    const element = value as ReactElement<{ href: string; children: string }>;
    expect(element.type).toBe("a");
    expect(element.props).toEqual({ href: "/summer", children: "Free shipping over $50" });
  });

  it("blocks-03: any JSON value is an argument and reaches the function unchanged", async () => {
    const args = {
      s: "x",
      n: 4.5,
      t: true,
      f: false,
      z: null,
      a: [1, "two", null, { three: 3 }],
      o: { nested: { deep: [true] } },
    };
    const fn = vi.fn((props: unknown) => props);
    const [value, error] = await clientWith({ echo: fn }).resolve({
      __resolveType: "echo",
      ...args,
    });
    expect(error).toBeNull();
    expect(value).toEqual(args);
  });

  it("blocks-04: a block function gets one argument, its inputs, and no context; no requestScope helper exists", async () => {
    let count = -1;
    let received: Record<string, unknown> = {};
    const [, error] = await clientWith({
      probe: function (this: unknown, ...args: unknown[]) {
        count = args.length;
        received = args[0] as Record<string, unknown>;
        return null;
      },
    }).resolve({ __resolveType: "probe", a: 1 });
    expect(error).toBeNull();
    expect(count).toBe(1);
    expect(Object.keys(received)).toEqual(["a"]);
    expect(Object.keys(root)).not.toContain("requestScope");
  });

  it("blocks-05/blocks-07: nested blocks resolve inside out; product-card gets the awaited Product (the docs' client.resolve example)", async () => {
    const order: string[] = [];
    let received: unknown;
    const cms = createCMS({
      blocks: {
        "catalog-product": async (p: { slug: string }) => {
          order.push("catalog-product");
          await new Promise((r) => setTimeout(r, 5));
          return catalogProduct(p);
        },
        "product-card": (p: { title: string; product: unknown }) => {
          order.push("product-card");
          received = p.product;
          return productCard(p as never);
        },
      },
      content: { revision: "r", blocks: {} },
    });
    const client = cms.forRelease();
    const [card, error] = await client.resolve({
      __resolveType: "product-card",
      title: "Summer collection",
      product: { __resolveType: "catalog-product", slug: "summer-shirt" },
    });
    expect(error).toBeNull();
    expect(order).toEqual(["catalog-product", "product-card"]);
    expect(received).toEqual({ name: "Summer shirt", slug: "summer-shirt" });
    expect(isValidElement(card)).toBe(true);
    expect((card as ReactElement<{ product: unknown }>).props.product).toEqual({
      name: "Summer shirt",
      slug: "summer-shirt",
    });
  });

  it("blocks-06: every argument resolves before the function runs, except a lazy block", async () => {
    let seen: Record<string, unknown> = {};
    const [, error] = await clientWith({
      ...blockMap,
      card: (p: Record<string, unknown>) => {
        seen = p;
        return null;
      },
    }).resolve({
      __resolveType: "card",
      eager: { __resolveType: "catalog-product", slug: "a" },
      list: [{ __resolveType: "catalog-product", slug: "b" }],
      later: { __resolveType: "lazy", value: { __resolveType: "catalog-product", slug: "c" } },
    });
    expect(error).toBeNull();
    expect(seen.eager).toEqual({ name: "a", slug: "a" });
    expect(seen.list).toEqual([{ name: "b", slug: "b" }]);
    expect(typeof seen.later).toBe("function");
    expect(catalogCalls.count).toBe(2);
  });

  it("blocks-08: resolve never throws: [value, null] or [null, error]", async () => {
    const client = clientWith({
      boom: () => {
        throw new Error("nope");
      },
    });
    const failed = await client.resolve({ __resolveType: "boom" });
    expect(failed[0]).toBeNull();
    expect(failed[1]?.code).toBe("BLOCK_FAILED");
    const unknown = await client.resolve({ __resolveType: "nope" });
    expect(unknown).toEqual([null, expect.objectContaining({ code: "UNKNOWN_BLOCK" })]);
    expectTypeOf(client.resolve).returns.resolves.toEqualTypeOf<Result<unknown>>();
  });

  it("blocks-09: resolve takes any JSON; arrays give arrays; undefined entries are left out", async () => {
    const client = clientWith(blockMap);
    const promo = { __resolveType: "promo-banner", title: "t", href: "/h" };
    const hidden = {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "never" }, value: { __resolveType: "lazy", value: promo } },
      ],
    };
    const [obj] = await client.resolve<{ a: number; b: ReactElement }>({ a: 1, b: promo });
    expect(obj?.a).toBe(1);
    expect(isValidElement(obj?.b)).toBe(true);
    const [list, error] = await client.resolve<unknown[]>([promo, hidden, promo]);
    expect(error).toBeNull();
    expect(list).toHaveLength(2);
    expect(await client.resolve("plain text is a saved-block name")).toEqual([
      null,
      expect.objectContaining({ code: "NOT_FOUND" }),
    ]);
    expect(await client.resolve(42)).toEqual([42, null]);
  });

  it("blocks-10/blocks-11: the block map is `satisfies Blocks`, keeps exact function types, and is createCMS's `blocks`", async () => {
    expectTypeOf(blockMap["product-card"]).toEqualTypeOf<typeof productCard>();
    expectTypeOf(blockMap["promo-banner"]).toEqualTypeOf<typeof PromoBanner>();
    expectTypeOf(blockMap).toMatchTypeOf<Blocks>();
    const cms = createCMS({ blocks: blockMap, content: { revision: "r", blocks: {} } });
    const [, error] = await cms.forRelease().resolve(summerCardJson);
    expect(error).toBeNull();
  });

  it("blocks-12: any name outside the registry fails with UNKNOWN_BLOCK", async () => {
    const [value, error] = await clientWith(blockMap).resolve({ __resolveType: "nope" });
    expect(value).toBeNull();
    expect(error?.code).toBe("UNKNOWN_BLOCK");
  });

  it("blocks-13/builtin-01: exactly nine built-ins, always in the registry, no UNKNOWN_BLOCK with an empty map", async () => {
    expect(Object.keys(builtIns).sort()).toEqual([...BUILT_INS].sort());
    const client = clientWith({});
    for (const name of BUILT_INS) {
      const [, error] = await client.resolve({ __resolveType: name });
      expect(error?.code, name).not.toBe("UNKNOWN_BLOCK");
    }
  });

  it("blocks-14/builtin-24: the registry is { ...savedBlocks, ...builtIns, ...blocks }: the block map wins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const myPage = vi.fn(() => "my page");
    const x = vi.fn(() => "fn x");
    const client = clientWith(
      { page: myPage, x },
      {
        page: { __resolveType: "always" },
        x: { __resolveType: "never" },
        multivariate: { __resolveType: "never" },
      },
    );
    expect(await client.resolve({ __resolveType: "page", sections: [] })).toEqual([
      "my page",
      null,
    ]);
    expect(await client.resolve({ __resolveType: "x" })).toEqual(["fn x", null]);
    // A built-in beats a saved block of the same name.
    const [mv] = await client.resolve({ __resolveType: "multivariate", variants: [] });
    expect(mv).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("blocks-15/saved-09: a saved block is replaced by { ...saved, ...arguments } and looked up again", async () => {
    const seo = vi.fn((p: { title: string; description: string }) => p);
    const client = clientWith(
      { seo },
      {
        SummerSEO: {
          __resolveType: "seo",
          title: "Sunny!",
          description: "Light layers for long days.",
          meta: { a: 1, b: 2 },
        },
      },
    );
    const [merged] = await client.resolve({ __resolveType: "SummerSEO", title: "Summer sale" });
    expect(merged).toEqual({
      title: "Summer sale",
      description: "Light layers for long days.",
      meta: { a: 1, b: 2 },
    });
    const [plain] = await client.resolve("SummerSEO");
    expect((plain as { title: string }).title).toBe("Sunny!");
    // Shallow: a nested object override replaces the whole property.
    const [shallow] = await client.resolve({ __resolveType: "SummerSEO", meta: { a: 9 } });
    expect((shallow as { meta: unknown }).meta).toEqual({ a: 9 });
  });
});

// ===========================================================================
// saved-blocks.mdx
// ===========================================================================

describe("saved blocks", () => {
  const saved = {
    SummerCard: summerCardJson,
    HomePage: { __resolveType: "page", path: "/", sections: [{ __resolveType: "SummerCard" }] },
  };

  it("saved-03/saved-06: a string target is a saved block's name; a block type there is NOT_FOUND", async () => {
    const client = clientWith(blockMap, saved);
    const [card, error] = await client.resolve("SummerCard");
    expect(error).toBeNull();
    expect(isValidElement(card)).toBe(true);
    expect(await client.resolve("product-card")).toEqual([
      null,
      expect.objectContaining({ code: "NOT_FOUND" }),
    ]);
  });

  it("saved-04: what's saved is the call: catalogProduct runs on each resolve (per client)", async () => {
    const cms = cmsWith(blockMap, saved);
    await cms.forRelease().resolve("SummerCard");
    await cms.forRelease().resolve("SummerCard");
    expect(catalogCalls.count).toBe(2);
  });

  it("saved-05: { __resolveType: 'SummerCard' } in a page's sections is replaced in place (HomePage.json)", async () => {
    const [home, error] = await clientWith(blockMap, saved).resolve<{
      path: string;
      sections: ReactElement<{ title: string }>[];
    }>("HomePage");
    expect(error).toBeNull();
    expect(home?.path).toBe("/");
    expect(home?.sections).toHaveLength(1);
    expect(home?.sections[0].props.title).toBe("Summer collection");
  });

  it("saved-07: { run: false } returns the JSON with saved blocks in place and runs nothing", async () => {
    const card = vi.fn(productCard);
    const client = clientWith({ ...blockMap, "product-card": card }, saved);
    const [json, error] = await client.resolve("HomePage", { run: false });
    expect(error).toBeNull();
    expect(json).toEqual({ __resolveType: "page", path: "/", sections: [summerCardJson] });
    expect(card).not.toHaveBeenCalled();
    expect(catalogCalls.count).toBe(0);
  });

  it("saved-08: Block is exported as { __resolveType: string; ...arguments }", () => {
    const block: Block = { __resolveType: "SummerCard", title: "x" };
    expectTypeOf(block.__resolveType).toEqualTypeOf<string>();
    // @ts-expect-error a Block needs __resolveType
    const missing: Block = { title: "x" };
    void missing;
  });

  it("saved-10/res-03: a saved block named like a block type: the function wins, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = clientWith(blockMap, { "promo-banner": { __resolveType: "never" } });
    const [value] = await client.resolve({ __resolveType: "promo-banner", title: "t", href: "/" });
    expect(isValidElement(value)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"promo-banner"'));
  });
});

// ===========================================================================
// how-resolution-works.mdx
// ===========================================================================

describe("how resolution works", () => {
  const saved = {
    CurrentProduct: { __resolveType: "catalog-product", slug: "summer-shirt" },
    SummerCard: {
      __resolveType: "product-card",
      title: "Summer collection",
      product: { __resolveType: "CurrentProduct" },
    },
  };

  it("res-01: the walkthrough: resolve('SummerCard') and its { run: false } read", async () => {
    const client = clientWith(blockMap, saved);
    const [card] =
      await client.resolve<ReactElement<{ title: string; product: unknown }>>("SummerCard");
    expect(card?.props).toEqual({
      title: "Summer collection",
      product: { name: "Summer shirt", slug: "summer-shirt" },
    });
    expect(await client.resolve("SummerCard", { run: false })).toEqual([
      {
        __resolveType: "product-card",
        title: "Summer collection",
        product: { __resolveType: "catalog-product", slug: "summer-shirt" },
      },
      null,
    ]);
  });

  it("res-02: a descriptor or a React element is returned as is", async () => {
    const descriptor = { component: "product-card", props: {} };
    const client = clientWith({
      d: () => descriptor,
      e: () => PromoBanner({ title: "t", href: "/" }),
    });
    expect((await client.resolve({ __resolveType: "d" }))[0]).toBe(descriptor);
    expect(isValidElement((await client.resolve({ __resolveType: "e" }))[0])).toBe(true);
  });

  it("res-04: siblings resolve concurrently, children before parents", async () => {
    const started: string[] = [];
    const { gate, release } = deferred();
    const slow = (name: string) => async () => {
      started.push(name);
      await gate;
      return name;
    };
    const pending = clientWith({ a: slow("a"), b: slow("b"), parent: (p: unknown) => p }).resolve({
      __resolveType: "parent",
      x: { __resolveType: "a" },
      y: { __resolveType: "b" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(started.sort()).toEqual(["a", "b"]);
    release();
    expect(await pending).toEqual([{ x: "a", y: "b" }, null]);
  });

  it("res-05: a failing nested block stops its parent; error.path says where", async () => {
    const parent = vi.fn(() => "never");
    const [value, error] = await clientWith({
      parent,
      child: () => {
        throw new Error("down");
      },
    }).resolve({ __resolveType: "parent", product: { __resolveType: "child" } });
    expect(value).toBeNull();
    expect(parent).not.toHaveBeenCalled();
    expect(error?.code).toBe("BLOCK_FAILED");
    expect(error?.path).toEqual(["product"]);
    expect((error?.cause as Error | undefined)?.message).toBe("down");
  });

  it("res-06: a name with no saved block is NOT_FOUND, even a built-in's", async () => {
    const client = clientWith(blockMap);
    for (const name of ["Missing", "always"]) {
      expect(await client.resolve(name)).toEqual([
        null,
        expect.objectContaining({ code: "NOT_FOUND" }),
      ]);
    }
  });

  it("res-07: results are returned as is; __resolveType is stripped before the call", async () => {
    const returned = { __resolveType: "boom", nested: { __resolveType: "boom" } };
    const boom = vi.fn(() => {
      throw new Error("should never be looked up");
    });
    const identity = vi.fn((p: unknown) => p);
    const client = clientWith({ make: () => returned, boom, seo: identity });
    expect((await client.resolve({ __resolveType: "make" }))[0]).toBe(returned);
    expect(boom).not.toHaveBeenCalled();
    const [seo] = await client.resolve({ __resolveType: "seo", title: "t" });
    expect(seo).toEqual({ title: "t" });
    expect(identity.mock.calls[0][0]).not.toHaveProperty("__resolveType");
  });

  it("res-08: saved blocks that loop fail with CYCLE and the chain in error.path", async () => {
    const client = clientWith(
      {},
      { A: { __resolveType: "B" }, B: { __resolveType: "A" }, Self: { __resolveType: "Self" } },
    );
    const [, error] = await client.resolve("A");
    expect(error?.code).toBe("CYCLE");
    expect(error?.path).toEqual(["A", "B", "A"]);
    expect((await client.resolve("Self"))[1]?.path).toEqual(["Self", "Self"]);
    expect((await client.resolve("A", { run: false }))[1]?.code).toBe("CYCLE");
  });

  it("res-09: client.list(type, options) returns what { run: false } returns by default", async () => {
    const card = vi.fn(productCard);
    const client = clientWith({ ...blockMap, "product-card": card }, saved);
    const [entries, error] = await client.list("product-card");
    expect(error).toBeNull();
    expect(entries).toEqual([(await client.resolve("SummerCard", { run: false }))[0]]);
    expect(card).not.toHaveBeenCalled();
    const [limited] = await client.list("product-card", { limit: 0 });
    expect(limited).toEqual([]);
  });

  it("res-10: error codes NOT_FOUND, UNKNOWN_BLOCK, CYCLE and BLOCK_FAILED, with code/message/path/cause", async () => {
    expectTypeOf<"NOT_FOUND" | "UNKNOWN_BLOCK" | "CYCLE" | "BLOCK_FAILED">().toMatchTypeOf<
      CMSError["code"]
    >();
    const [, error] = await clientWith({
      f: () => {
        throw new Error("x");
      },
    }).resolve({ __resolveType: "f" });
    expect(error).toMatchObject({ code: "BLOCK_FAILED", path: [] });
    expect(typeof error?.message).toBe("string");
    expect(error?.cause).toBeInstanceOf(Error);
  });
});

// ===========================================================================
// lazy-blocks.mdx
// ===========================================================================

describe("lazy blocks", () => {
  const card = (showProduct: boolean) => ({
    __resolveType: "product-card",
    title: "Summer collection",
    showProduct,
    product: {
      __resolveType: "lazy",
      value: { __resolveType: "catalog-product", slug: "summer-shirt" },
    },
  });
  const blocks = { "catalog-product": catalogProduct, "product-card": lazyProductCard };

  it("lazy-01/lazy-04: the docs' productCard: catalogProduct runs only when product() is called", async () => {
    const client = clientWith(blocks);
    const [title, e1] = await client.resolve<ReactElement<{ text: string }>>(card(false));
    expect(e1).toBeNull();
    expect(title?.props.text).toBe("Summer collection");
    expect(catalogCalls.count).toBe(0);
    const [full, e2] = await client.resolve<ReactElement<{ product: unknown }>>(card(true));
    expect(e2).toBeNull();
    expect(full?.props.product).toEqual({ name: "Summer shirt", slug: "summer-shirt" });
    expect(catalogCalls.count).toBe(1);
    expectTypeOf<Lazy<number>>().toEqualTypeOf<() => Promise<number>>();
  });

  it("lazy-02: at most once: a second call returns the same result", async () => {
    let results: unknown[] = [];
    const [, error] = await clientWith({
      ...blocks,
      twice: async ({ product }: { product: Lazy<unknown> }) => {
        results = [await product(), await product()];
        return null;
      },
    }).resolve({ __resolveType: "twice", product: card(true).product });
    expect(error).toBeNull();
    expect(catalogCalls.count).toBe(1);
    expect(results[0]).toBe(results[1]);
  });

  it("lazy-03: a failing value rejects the call; the caller handles it", async () => {
    const [value, error] = await clientWith({
      broken: () => {
        throw new Error("down");
      },
      safe: async ({ product }: { product: Lazy<unknown> }) => {
        try {
          return await product();
        } catch {
          return "fallback";
        }
      },
    }).resolve({
      __resolveType: "safe",
      product: { __resolveType: "lazy", value: { __resolveType: "broken" } },
    });
    expect([value, error]).toEqual(["fallback", null]);
  });

  it("builtin-02: lazy wraps any JSON value too", async () => {
    let got: unknown;
    await clientWith({
      take: async ({ v }: { v: Lazy<unknown> }) => {
        got = await v();
        return null;
      },
    }).resolve({ __resolveType: "take", v: { __resolveType: "lazy", value: { a: [1] } } });
    expect(got).toEqual({ a: [1] });
  });
});

// ===========================================================================
// built-in-blocks.mdx
// ===========================================================================

describe("built-in blocks", () => {
  const counted = () => {
    const runs: string[] = [];
    const value = (name: string) => ({
      __resolveType: "lazy",
      value: { __resolveType: "mark", name },
    });
    const blocks = {
      mark: ({ name }: { name: string }) => {
        runs.push(name);
        return name;
      },
    };
    return { runs, value, blocks };
  };

  it("builtin-03/mv-02/lazy-07: multivariate returns the first true variant; rules all run, only the winner's value runs", async () => {
    const { runs, value, blocks } = counted();
    const rules: string[] = [];
    const rule = (result: boolean, name: string) => ({ __resolveType: "rule", result, name });
    const client = clientWith({
      ...blocks,
      rule: ({ result, name }: { result: boolean; name: string }) => {
        rules.push(name);
        return result;
      },
    });
    const [picked, error] = await client.resolve({
      __resolveType: "multivariate",
      experiment: "exp-1",
      variants: [
        { rule: rule(false, "r1"), value: value("v1") },
        { rule: rule(true, "r2"), value: value("v2") },
        { rule: rule(true, "r3"), value: value("v3") },
      ],
    });
    expect([picked, error]).toEqual(["v2", null]);
    expect(runs).toEqual(["v2"]);
    expect(rules.sort()).toEqual(["r1", "r2", "r3"]);
    const [none] = await client.resolve({
      __resolveType: "multivariate",
      variants: [{ rule: { __resolveType: "never" }, value: value("v4") }],
    });
    expect(none).toBeUndefined();
    expect(runs).toEqual(["v2"]);
  });

  it("builtin-04: always is true, never is false", async () => {
    const client = clientWith({});
    expect(await client.resolve({ __resolveType: "always" })).toEqual([true, null]);
    expect(await client.resolve({ __resolveType: "never" })).toEqual([false, null]);
  });

  it("builtin-05/mv-05: date is true from start (inclusive) until end (exclusive); dates without time are UTC midnight", async () => {
    vi.useFakeTimers();
    const client = () => clientWith({});
    const at = async (now: string, block: Record<string, unknown>) => {
      vi.setSystemTime(new Date(now));
      return (await client().resolve({ __resolveType: "date", ...block }))[0];
    };
    const window = { start: "2026-11-27T00:00:00-05:00", end: "2026-12-01T00:00:00-05:00" };
    expect(await at("2026-11-27T05:00:00Z", window)).toBe(true);
    expect(await at("2026-11-27T04:59:59Z", window)).toBe(false);
    expect(await at("2026-12-01T05:00:00Z", window)).toBe(false);
    expect(await at("2030-01-01T00:00:00Z", {})).toBe(true);
    expect(await at("2026-11-27T00:00:00Z", { start: "2026-11-27" })).toBe(true);
    expect(await at("2026-11-26T23:59:59Z", { start: "2026-11-27" })).toBe(false);
    expect(await at("2026-11-27T00:00:00Z", { end: "2026-11-27" })).toBe(false);
  });

  it("builtin-06: page resolves seo and every section; Page/Route/Seo are exported", async () => {
    const [page, error] = await clientWith(blockMap).resolve<Page>({
      __resolveType: "page",
      name: "Home",
      path: "/",
      seo: { title: "t", description: "d" },
      sections: [{ __resolveType: "promo-banner", title: "x", href: "/" }],
    });
    expect(error).toBeNull();
    expect(page).toMatchObject({ name: "Home", path: "/", seo: { title: "t", description: "d" } });
    expect(isValidElement(page?.sections[0])).toBe(true);
    expectTypeOf<Page>().toMatchTypeOf<Route>();
    expectTypeOf<Page["seo"]>().toEqualTypeOf<Seo | undefined>();
    expectTypeOf<Page["sections"]>().toEqualTypeOf<import("react").ReactNode[]>();
  });

  it("builtin-07: redirect returns its arguments as saved", async () => {
    const args = {
      from: "/a",
      to: "/b",
      permanent: false,
      status: 308,
      discardQueryParameters: true,
    };
    expect(await clientWith({}).resolve({ __resolveType: "redirect", ...args })).toEqual([
      args,
      null,
    ]);
  });

  it("builtin-08/builtin-09: cms-settings returns its input with the telemetry and analytics defaults filled in", async () => {
    const telemetry = { enabled: true, metrics: false, errorSampleRate: 0.5, traceSampleRate: 0 };
    const preview = { hosts: ["staging.example.com"] };
    expect(
      await clientWith({}).resolve({ __resolveType: "cms-settings", preview, telemetry }),
    ).toEqual([
      { preview, telemetry, analytics: { collector: HOSTED_ANALYTICS_COLLECTOR, enabled: true } },
      null,
    ]);
    expect(HOSTED_ANALYTICS_COLLECTOR).toMatch(/^https:\/\//);
  });

  it("builtin-25: the StorePage example: returning props gives the resolved page plus theme", async () => {
    const [page, error] = await clientWith(storeBlockMap).resolve<Page & { theme: string }>({
      __resolveType: "page",
      name: "Home",
      path: "/",
      theme: "dark",
      seo: { __resolveType: "seo", title: "t", description: "d" },
      sections: [{ __resolveType: "hero", title: "Hi" }],
    });
    expect(error).toBeNull();
    expect(page?.theme).toBe("dark");
    expect(page?.seo).toEqual({ title: "t", description: "d" });
    expect(isValidElement(page?.sections[0])).toBe(true);
  });
});

// ===========================================================================
// built-in-blocks.mdx › Secrets
// ===========================================================================

describe("secrets", () => {
  let pub: string;
  let priv: string;
  let tmp: string;

  beforeAll(() => {
    // builtin-16: the docs' OpenSSL commands, as written.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deco-secrets-"));
    fs.mkdirSync(path.join(tmp, ".deco"));
    execFileSync(
      "openssl",
      [
        "genpkey",
        "-algorithm",
        "RSA",
        "-pkeyopt",
        "rsa_keygen_bits:3072",
        "-out",
        "deco-secrets.key",
      ],
      { cwd: tmp, stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      ["pkey", "-in", "deco-secrets.key", "-pubout", "-out", ".deco/secrets.pub"],
      {
        cwd: tmp,
        stdio: "ignore",
      },
    );
    priv = fs.readFileSync(path.join(tmp, "deco-secrets.key"), "utf8");
    pub = fs.readFileSync(path.join(tmp, ".deco/secrets.pub"), "utf8");
    return () => fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  it("builtin-14: encryptSecret returns a ready secret block", async () => {
    const block = await encryptSecret(pub, "x");
    expect(block.__resolveType).toBe("secret");
    expect(block.ciphertext).toMatch(/^v1\./);
  });

  it("builtin-10/builtin-15/builtin-16: createCMS({ secrets: { key } }) decrypts with OpenSSL's keys, line breaks included", async () => {
    expect(priv).toContain("-----BEGIN PRIVATE KEY-----\n");
    const block = await encryptSecret(pub, "abc");
    const env = { DECO_SECRETS_KEY: priv } as Record<string, string | undefined>;
    const cms = createCMS({
      blocks: {},
      content: { revision: "r", blocks: {} },
      secrets: { key: env.DECO_SECRETS_KEY },
    });
    expect(await cms.forRelease().resolve(block)).toEqual(["abc", null]);
  });

  it("builtin-11: Secret is a tagged string usable as a string (the newsletter example)", async () => {
    expectTypeOf<Secret>().toMatchTypeOf<string>();
    const block = await encryptSecret(pub, "re_live_123");
    const cms = cmsWith({ newsletter }, {}, priv);
    expect(
      await cms
        .forRelease()
        .resolve({ __resolveType: "newsletter", listId: "weekly", apiKey: block }),
    ).toEqual([{ listId: "weekly", keyLength: 11 }, null]);
  });

  it("builtin-17: AES-256-GCM per value, wrapped with RSA-OAEP SHA-256, via Web Crypto; @decocms/blocks/secrets bundles for a browser", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    await encryptSecret(pub, "x");
    expect(
      importKey.mock.calls.some(
        (c) =>
          c[0] === "spki" &&
          (c[2] as RsaHashedImportParams).name === "RSA-OAEP" &&
          (c[2] as RsaHashedImportParams).hash === "SHA-256",
      ),
    ).toBe(true);
    const aesKeyBytes = importKey.mock.calls.find((c) => c[0] === "raw")?.[1] as Uint8Array;
    expect(aesKeyBytes.byteLength).toBe(32);
    expect(encrypt.mock.calls.map((c) => (c[0] as { name: string }).name).sort()).toEqual([
      "AES-GCM",
      "RSA-OAEP",
    ]);
    const esbuild = path.join(here, "../../../../../node_modules/.bin/esbuild");
    const out = execFileSync(
      esbuild,
      [path.join(here, "../secrets.ts"), "--bundle", "--format=esm", "--platform=browser"],
      {
        encoding: "utf8",
      },
    );
    expect(out).not.toMatch(/node:|require\(/);
    expect(out).toContain("encryptSecret");
  });

  it("builtin-18 (browser): a secret block resolved in a browser fails with BLOCK_FAILED", async () => {
    const block = await encryptSecret(pub, "abc");
    const cms = cmsWith({}, {}, priv);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const [value, error] = await cms.forRelease().resolve(block);
    expect(value).toBeNull();
    expect(error?.code).toBe("BLOCK_FAILED");
  });

  it("builtin-18 (server only): the core registers no taint hook; a secret stays server-side by resolution", async () => {
    // built-in-blocks.mdx › Secrets: secrets resolve on the server only; any
    // taint (React's experimental_taintUniqueValue) is the site's own code.
    const hook = Symbol.for("decocms.blocks.taint");
    const taint = vi.fn();
    (globalThis as Record<symbol, unknown>)[hook] = taint;
    try {
      const block = await encryptSecret(pub, "abc");
      const [value] = await cmsWith({}, {}, priv).forRelease().resolve(block);
      expect(value).toBe("abc");
      expect(taint).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as Record<symbol, unknown>)[hook];
    }
  });

  it("builtin-19: { run: false } and client.list return the secret block as saved", async () => {
    const block = await encryptSecret(pub, "abc");
    const client = cmsWith(
      { newsletter },
      { Newsletter: { __resolveType: "newsletter", listId: "l", apiKey: block } },
      priv,
    ).forRelease();
    expect((await client.resolve("Newsletter", { run: false }))[0]).toEqual({
      __resolveType: "newsletter",
      listId: "l",
      apiKey: block,
    });
    expect((await client.list("newsletter"))[0]).toEqual([
      { __resolveType: "newsletter", listId: "l", apiKey: block },
    ]);
  });

  it("builtin-20: the content protocol refuses a plain string in a Secret field", () => {
    const meta = {
      manifest: {
        blocks: { sections: { newsletter: { $ref: "#/definitions/bmV3c2xldHRlcg==" } } },
      },
      schema: {
        definitions: {
          "bmV3c2xldHRlcg==": {
            type: "object",
            properties: {
              __resolveType: { enum: ["newsletter"] },
              apiKey: { type: "object", format: "secret" },
            },
          },
        },
        root: {},
      },
    };
    const violations = checkSecrets(
      "Newsletter",
      { __resolveType: "newsletter", apiKey: "plaintext" },
      meta as never,
    );
    expect(violations.map((v) => v.rule)).toEqual(["secret-field"]);
  });

  it("builtin-21: without a key, or with the wrong one, only the secret block fails (BLOCK_FAILED)", async () => {
    const block = await encryptSecret(pub, "abc");
    const page = {
      __resolveType: "page",
      name: "Home",
      path: "/",
      sections: [
        { __resolveType: "promo-banner", title: "ok", href: "/" },
        { __resolveType: "newsletter", listId: "l", apiKey: block },
      ],
    };
    const blocks = { ...blockMap, newsletter };
    // The whole page fails (a nested failure stops the parent); each section on its own:
    const client = cmsWith(blocks).forRelease();
    const [whole, wholeError] = await client.resolve(page);
    expect(whole).toBeNull();
    expect(wholeError?.code).toBe("BLOCK_FAILED");
    const [stored] = await client.resolve(page, { run: false });
    const results = await Promise.all(
      (stored as typeof page).sections.map((s) => client.resolve(s)),
    );
    expect(results[0][1]).toBeNull();
    expect(results[1][1]?.code).toBe("BLOCK_FAILED");
    const wrong = await encryptSecret(pub, "abc");
    const other = execFileSync(
      "openssl",
      ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"],
      { encoding: "utf8" },
    );
    expect((await cmsWith({}, {}, other).forRelease().resolve(wrong))[1]?.code).toBe(
      "BLOCK_FAILED",
    );
  }, 30_000);

  it("builtin-22: decrypted values never appear in telemetry logs or spans", async () => {
    const plaintext = "re_live_PLAINTEXT_42";
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const raw = Buffer.from(init?.body as Uint8Array);
      sent.push(
        new Headers(init?.headers).get("content-encoding") === "gzip"
          ? gunzipSync(raw).toString()
          : raw.toString(),
      );
      return new Response(null, { status: 200 });
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const tasks: (() => Promise<void>)[] = [];
    const hook = Symbol.for("decocms.blocks.background");
    (globalThis as Record<symbol, unknown>)[hook] = (t: () => Promise<void>) => tasks.push(t);
    const now = Date.now.bind(Date);
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + clock);
    try {
      const block = await encryptSecret(pub, plaintext);
      const cms = createCMS({
        blocks: {
          // An upstream error that quotes the key, as SDKs often do.
          send: ({ apiKey }: { apiKey: string }) => {
            throw new Error(`401 from upstream: invalid key ${apiKey}`);
          },
          ok: ({ apiKey }: { apiKey: string }) => apiKey.length,
        },
        content: {
          revision: "r",
          blocks: {
            CMS: {
              __resolveType: "cms-settings",
              telemetry: { traceSampleRate: 1, errorSampleRate: 1 },
            },
          },
        },
        secrets: { key: priv },
        telemetry: {
          endpoint: "https://otel.example.com",
          limits: { traceSampleRate: 1, errorSampleRate: 1 },
        },
      });
      await cms.forRelease().revision();
      const client = cms.forRelease();
      expect((await client.resolve({ __resolveType: "ok", apiKey: block }))[1]).toBeNull();
      expect((await client.resolve({ __resolveType: "send", apiKey: block }))[1]?.code).toBe(
        "BLOCK_FAILED",
      );
      while (tasks.length > 0) {
        clock += 10_000;
        await Promise.all(tasks.splice(0).map((t) => t()));
      }
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.join("\n")).not.toContain(plaintext);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[hook];
    }
  });
});

// ===========================================================================
// matchers-and-variants.mdx
// ===========================================================================

describe("matchers and variants", () => {
  const blackFriday = {
    __resolveType: "promo-banner",
    title: {
      __resolveType: "multivariate",
      variants: [
        {
          rule: {
            __resolveType: "date",
            start: "2026-11-27T00:00:00-05:00",
            end: "2026-12-01T00:00:00-05:00",
          },
          value: { __resolveType: "lazy", value: "Black Friday: 40% off everything" },
        },
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: "Free shipping over $50" },
        },
      ],
    },
    href: "/deals",
  };

  it("mv-01: the Black Friday example: PromoBanner gets a plain string, switched by date", async () => {
    vi.useFakeTimers();
    const title = async (now: string) => {
      vi.setSystemTime(new Date(now));
      const [banner, error] =
        await clientWith(blockMap).resolve<ReactElement<{ children: unknown }>>(blackFriday);
      expect(error).toBeNull();
      return banner?.props.children;
    };
    expect(await title("2026-11-28T12:00:00-05:00")).toBe("Black Friday: 40% off everything");
    expect(await title("2026-12-01T00:00:00-05:00")).toBe("Free shipping over $50");
    expect(await title("2026-11-26T23:59:59-05:00")).toBe("Free shipping over $50");
  });

  it("mv-06: a block hidden by never resolves to undefined, runs nothing, and drops out of sections", async () => {
    const inner = vi.fn(() => "inner");
    const [page, error] = await clientWith({ ...blockMap, inner }).resolve<Page>({
      __resolveType: "page",
      name: "Home",
      path: "/",
      sections: [
        { __resolveType: "promo-banner", title: "ok", href: "/" },
        {
          __resolveType: "multivariate",
          variants: [
            {
              rule: { __resolveType: "never" },
              value: { __resolveType: "lazy", value: { __resolveType: "inner" } },
            },
          ],
        },
      ],
    });
    expect(error).toBeNull();
    expect(page?.sections).toHaveLength(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it("mv-07: the weekday matcher example, registered with satisfies Blocks, picks the weekend title", async () => {
    vi.useFakeTimers();
    const weekend = {
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "weekday", days: ["Sat", "Sun"] },
          value: { __resolveType: "lazy", value: "Weekend: free shipping on everything" },
        },
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: "Free shipping over $50" },
        },
      ],
    };
    expectTypeOf(weekdayBlockMap.weekday).toEqualTypeOf<typeof weekday>();
    vi.setSystemTime(new Date("2026-11-28T15:00:00-05:00")); // a Saturday in New York
    expect((await clientWith(weekdayBlockMap).resolve(weekend))[0]).toBe(
      "Weekend: free shipping on everything",
    );
    vi.setSystemTime(new Date("2026-11-25T15:00:00-05:00")); // a Wednesday
    expect((await clientWith(weekdayBlockMap).resolve(weekend))[0]).toBe("Free shipping over $50");
  });

  it("mv-09: async matchers are awaited", async () => {
    const [picked] = await clientWith({ later: async () => true }).resolve({
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "later" }, value: { __resolveType: "lazy", value: "async won" } },
        { rule: { __resolveType: "always" }, value: { __resolveType: "lazy", value: "fallback" } },
      ],
    });
    expect(picked).toBe("async won");
  });

  it("mv-10: one-line not/and matchers; and's Lazy<boolean> b runs only if a is true", async () => {
    const b = vi.fn(() => true);
    const client = clientWith({ not, and, b });
    const block = (a: boolean) => ({
      __resolveType: "and",
      a: { __resolveType: "not", rule: !a },
      b: { __resolveType: "lazy", value: { __resolveType: "b" } },
    });
    expect((await client.resolve(block(false)))[0]).toBe(false);
    expect(b).not.toHaveBeenCalled();
    expect((await client.resolve(block(true)))[0]).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("mv-11: declaring multivariate replaces the built-in", async () => {
    const mine = vi.fn(() => "mine");
    expect(
      (
        await clientWith({ multivariate: mine }).resolve({
          __resolveType: "multivariate",
          variants: [],
        })
      )[0],
    ).toBe("mine");
  });

  it("mv-12: the A/B split example with experiment; a visitor buckets the same way every time", async () => {
    const ab = {
      __resolveType: "multivariate",
      experiment: "hero-headline",
      variants: [
        {
          rule: { __resolveType: "split", experiment: "hero-headline", percent: 50 },
          value: { __resolveType: "lazy", value: "Summer starts here" },
        },
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: "New summer collection" },
        },
      ],
    };
    const expected = (id: string) =>
      bucket(`hero-headline:${id}`) < 50 ? "Summer starts here" : "New summer collection";
    for (const id of ["visitor-1", "visitor-2", "visitor-3", "abc"]) {
      visitor.id = id;
      const first = (await clientWith({ split }).resolve(ab))[0];
      const again = (await clientWith({ split }).resolve(ab))[0];
      expect(first).toBe(expected(id));
      expect(again).toBe(first);
    }
  });

  it("mv-15 (core contract the guides rely on): a hidden block is [undefined, null], a failed one [null, error]", async () => {
    const client = clientWith({
      boom: () => {
        throw new Error("x");
      },
    });
    expect(
      await client.resolve({
        __resolveType: "multivariate",
        variants: [
          { rule: { __resolveType: "never" }, value: { __resolveType: "lazy", value: 1 } },
        ],
      }),
    ).toEqual([undefined, null]);
    expect((await client.resolve({ __resolveType: "boom" }))[1]?.code).toBe("BLOCK_FAILED");
  });
});
