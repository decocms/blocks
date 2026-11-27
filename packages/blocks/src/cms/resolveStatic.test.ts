import { afterEach, describe, expect, it } from "vitest";
import { normalizeUrlsInObject, registerProductionOrigins } from "../sdk/normalizeUrls";
import { clearCommerceLoaders, registerCommerceLoader, resolveValue } from "./resolve";

const KEY = "test/loaders/static-fast-path";

describe("resolver static-subtree fast path", () => {
  afterEach(() => clearCommerceLoaders());

  it("returns a copy of static content, never the shared decofile object", async () => {
    const block = { title: "Glicerina", items: [{ text: "a" }, { text: "b" }], meta: { n: 1 } };
    const a = (await resolveValue(block)) as typeof block;
    const b = (await resolveValue(block)) as typeof block;

    expect(a).toEqual(block);
    expect(a).not.toBe(block);
    expect(a.items).not.toBe(block.items);
    expect(a.items[0]).not.toBe(block.items[0]);
    // One request mutating its props must not leak into the next one.
    a.items[0].text = "mutated";
    (a.meta as { n: number }).n = 99;
    expect(block.items[0].text).toBe("a");
    expect(b.items[0].text).toBe("a");
  });

  it("drops undefined array items like the async path did", async () => {
    const out = await resolveValue({ list: [1, undefined, 2] });
    expect(out).toEqual({ list: [1, 2] });
  });

  it("keeps key order when static and resolvable props are mixed", async () => {
    registerCommerceLoader(KEY, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { loaded: true };
    });
    const out = (await resolveValue({
      first: "static",
      products: { __resolveType: KEY },
      last: { nested: ["x"] },
    })) as Record<string, unknown>;

    expect(Object.keys(out)).toEqual(["first", "products", "last"]);
    expect(out.products).toEqual({ loaded: true });
    expect(out.last).toEqual({ nested: ["x"] });
  });

  it("still resolves blocks nested deep inside otherwise static content", async () => {
    registerCommerceLoader(KEY, async () => "resolved");
    const out = await resolveValue({ a: { b: [{ c: { __resolveType: KEY } }] } });
    expect(out).toEqual({ a: { b: [{ c: "resolved" }] } });
  });
});

describe("normalizeUrlsInObject copy-on-write", () => {
  afterEach(() => registerProductionOrigins([]));

  it("returns the same reference when nothing changes", () => {
    registerProductionOrigins(["https://www.acme.com"]);
    const obj = { a: "https://cdn.acme.com/x.png", list: [{ b: 1 }] };
    expect(normalizeUrlsInObject(obj)).toBe(obj);
  });

  it("copies only the changed branch, keeping key order and untouched siblings", () => {
    registerProductionOrigins(["https://www.acme.com"]);
    const keep = { b: 1 };
    const obj = {
      first: "x",
      link: "https://www.acme.com/p",
      last: keep,
      list: ["a", "https://www.acme.com"],
    };
    const out = normalizeUrlsInObject(obj);

    expect(out).not.toBe(obj);
    expect(Object.keys(out)).toEqual(["first", "link", "last", "list"]);
    expect(out).toEqual({ first: "x", link: "/p", last: keep, list: ["a", "/"] });
    expect(out.last).toBe(keep);
    expect(obj.link).toBe("https://www.acme.com/p");
  });
});
