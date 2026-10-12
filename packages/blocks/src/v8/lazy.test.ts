// @vitest-environment node
/** The built-in `lazy` block (lazy-blocks.mdx) and per-client memoization (api-reference). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lazy } from "./builtins/lazy";
import { createCMS, resetForTests } from "./cms";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Blocks, Lazy } from "./types";

beforeEach(() => resetForTests());

function client(blocks: Blocks) {
  return createCMS({ blocks, content: docsSnapshot() }).forRelease();
}

const lazyProduct = {
  __resolveType: "lazy",
  value: { __resolveType: "catalog-product", slug: "summer-shirt" },
};

describe("lazy blocks", () => {
  it("hands the function () => Promise<T> instead of the value", async () => {
    let received: unknown;
    const [, error] = await client({
      ...docsBlocks(),
      card: (props: { product: unknown }) => {
        received = props.product;
        return null;
      },
    }).resolve({ __resolveType: "card", product: lazyProduct });
    expect(error).toBeNull();
    expect(typeof received).toBe("function");
    await expect((received as Lazy<unknown>)()).resolves.toEqual({
      name: "Summer shirt",
      slug: "summer-shirt",
    });
  });

  it("runs the value only if the function calls it (the productCard example)", async () => {
    const catalogProduct = vi.fn(({ slug }: { slug: string }) => ({ name: "Summer shirt", slug }));
    const productCard = async ({
      title,
      showProduct,
      product,
    }: {
      title: string;
      showProduct: boolean;
      product: Lazy<{ name: string }>;
    }) => {
      if (!showProduct) return { title };
      const item = await product();
      return { title, product: item };
    };
    const c = client({ "catalog-product": catalogProduct, "product-card": productCard });

    const [hidden] = await c.resolve({
      __resolveType: "product-card",
      title: "Summer collection",
      showProduct: false,
      product: lazyProduct,
    });
    expect(hidden).toEqual({ title: "Summer collection" });
    expect(catalogProduct).not.toHaveBeenCalled();

    const [shown] = await c.resolve({
      __resolveType: "product-card",
      title: "Summer collection",
      showProduct: true,
      product: lazyProduct,
    });
    expect(shown).toEqual({
      title: "Summer collection",
      product: { name: "Summer shirt", slug: "summer-shirt" },
    });
    expect(catalogProduct).toHaveBeenCalledTimes(1);
  });

  it("resolves at most once: a second call returns the same result", async () => {
    const make = vi.fn(() => ({ id: Math.random() }));
    let thunk: Lazy<unknown> | undefined;
    await client({ make, take: ({ v }: { v: Lazy<unknown> }) => (thunk = v) }).resolve({
      __resolveType: "take",
      v: { __resolveType: "lazy", value: { __resolveType: "make" } },
    });
    const [a, b] = await Promise.all([thunk!(), thunk!()]);
    const c = await thunk!();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("rejects when called if the value fails; the caller handles it", async () => {
    const boom = new Error("catalog down");
    const [value, error] = await client({
      "catalog-product": () => {
        throw boom;
      },
      card: async ({ product }: { product: Lazy<unknown> }) => {
        try {
          return await product();
        } catch (e) {
          return {
            fallback: true,
            code: (e as { code: string }).code,
            cause: (e as { cause: unknown }).cause,
          };
        }
      },
    }).resolve({ __resolveType: "card", product: lazyProduct });
    expect(error).toBeNull();
    expect(value).toEqual({ fallback: true, code: "BLOCK_FAILED", cause: boom });
  });

  it("an unhandled lazy failure fails the caller with the inner error's code and path", async () => {
    const boom = new Error("catalog down");
    const [, error] = await client({
      "catalog-product": () => {
        throw boom;
      },
      card: async ({ product }: { product: Lazy<unknown> }) => product(),
    }).resolve({ __resolveType: "card", product: lazyProduct });
    expect(error).toMatchObject({ code: "BLOCK_FAILED", path: ["product", "value"], cause: boom });
  });

  it("the rejection is an Error, so stack traces survive", async () => {
    let caught: unknown;
    await client({
      bad: () => {
        throw new Error("x");
      },
      card: async ({ v }: { v: Lazy<unknown> }) => {
        await v().catch((e) => {
          caught = e;
        });
        return null;
      },
    }).resolve({
      __resolveType: "card",
      v: { __resolveType: "lazy", value: { __resolveType: "bad" } },
    });
    expect(caught).toBeInstanceOf(Error);
  });

  it("a lazy value that is never called never runs and never rejects unhandled", async () => {
    const bad = vi.fn(() => {
      throw new Error("never");
    });
    const [value, error] = await client({ bad, card: () => "ok" }).resolve({
      __resolveType: "card",
      v: { __resolveType: "lazy", value: { __resolveType: "bad" } },
    });
    expect([value, error]).toEqual(["ok", null]);
    expect(bad).not.toHaveBeenCalled();
  });

  it("wraps any JSON value, not only blocks", async () => {
    let thunk: Lazy<unknown> | undefined;
    await client({ take: ({ v }: { v: Lazy<unknown> }) => (thunk = v) }).resolve({
      __resolveType: "take",
      v: { __resolveType: "lazy", value: "Black Friday: 40% off everything" },
    });
    await expect(thunk!()).resolves.toBe("Black Friday: 40% off everything");
  });

  it("expands saved blocks inside the value when called", async () => {
    let thunk: Lazy<unknown> | undefined;
    await client({ ...docsBlocks(), take: ({ v }: { v: Lazy<unknown> }) => (thunk = v) }).resolve({
      __resolveType: "take",
      v: { __resolveType: "lazy", value: { __resolveType: "SummerSEO" } },
    });
    await expect(thunk!()).resolves.toEqual({
      title: "Sunny!",
      description: "Light layers for long days.",
    });
  });

  it("is the only special case: a key in the block map named lazy is an ordinary function", async () => {
    const mine = vi.fn((props: { value: unknown }) => props.value);
    const [value] = await client({ ...docsBlocks(), lazy: mine }).resolve({
      __resolveType: "lazy",
      value: { __resolveType: "SummerSEO" },
    });
    expect(mine).toHaveBeenCalledWith({
      value: { title: "Sunny!", description: "Light layers for long days." },
    });
    expect(value).toEqual({ title: "Sunny!", description: "Light layers for long days." });
  });

  it("called directly, outside the resolver, it still returns a Lazy<T>", async () => {
    await expect(lazy({ value: 7 })()).resolves.toBe(7);
  });

  it("a matcher can take an inner rule as Lazy<boolean> and skip it", async () => {
    const expensive = vi.fn(() => true);
    const and = async ({ a, b }: { a: boolean; b: Lazy<boolean> }) => a && (await b());
    const c = client({ and, expensive });
    const rule = (a: string) => ({
      __resolveType: "and",
      a: { __resolveType: a },
      b: { __resolveType: "lazy", value: { __resolveType: "expensive" } },
    });
    expect(await c.resolve(rule("never"))).toEqual([false, null]);
    expect(expensive).not.toHaveBeenCalled();
    expect(await c.resolve(rule("always"))).toEqual([true, null]);
    expect(expensive).toHaveBeenCalledTimes(1);
  });
});

describe("memoization — per client and per block-map function", () => {
  it("an entry referenced three times runs its function once per client", async () => {
    const catalogProduct = vi.fn(({ slug }: { slug: string }) => ({ slug }));
    const cms = createCMS({
      blocks: { ...docsBlocks(), "catalog-product": catalogProduct },
      content: docsSnapshot(),
    });
    const c = cms.forRelease();
    const target = [
      { __resolveType: "CurrentProduct" },
      { __resolveType: "CurrentProduct" },
      { __resolveType: "SummerCard" },
    ];
    await c.resolve(target);
    await c.resolve("CurrentProduct");
    expect(catalogProduct).toHaveBeenCalledTimes(1);

    await cms.forRelease().resolve("CurrentProduct");
    expect(catalogProduct).toHaveBeenCalledTimes(2);
  });

  it("identical inline blocks share one run, whatever their key order", async () => {
    const fn = vi.fn(() => ({}));
    await client({ fn }).resolve([
      { __resolveType: "fn", a: 1, b: { c: [1, 2] } },
      { b: { c: [1, 2] }, a: 1, __resolveType: "fn" },
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("different inputs run separately", async () => {
    const fn = vi.fn(() => ({}));
    await client({ fn }).resolve([
      { __resolveType: "fn", a: 1 },
      { __resolveType: "fn", a: 2 },
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("concurrent calls share the in-flight promise", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fn = vi.fn(async () => {
      await gate;
      return "v";
    });
    const c = client({ fn });
    const pending = Promise.all([
      c.resolve({ __resolveType: "fn" }),
      c.resolve({ __resolveType: "fn" }),
    ]);
    release();
    expect(await pending).toEqual([
      ["v", null],
      ["v", null],
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("results are kept per function: a rebuilt map starts with an empty cache", async () => {
    const calls: string[] = [];
    const makeBlocks = (label: string): Blocks => ({
      fn: () => {
        calls.push(label);
        return label;
      },
    });
    const c1 = createCMS({ blocks: makeBlocks("first"), content: docsSnapshot() }).forRelease();
    await c1.resolve({ __resolveType: "fn" });
    await c1.resolve({ __resolveType: "fn" });
    // A later createCMS for the same content adopts the new map (a hot reload).
    const c2 = createCMS({ blocks: makeBlocks("second"), content: docsSnapshot() }).forRelease();
    expect(await c2.resolve({ __resolveType: "fn" })).toEqual(["second", null]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("inputs that aren't JSON (a function passed by code) are resolved without memoizing", async () => {
    const fn = vi.fn((props: { cb: () => number }) => props.cb());
    const c = client({ fn });
    expect(await c.resolve({ __resolveType: "fn", cb: () => 1 })).toEqual([1, null]);
    expect(await c.resolve({ __resolveType: "fn", cb: () => 2 })).toEqual([2, null]);
  });
});
