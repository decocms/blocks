import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  categoryPathname,
  childrenOf,
  descendantSlugs,
  indexCategories,
  MAX_CATEGORY_DEPTH,
  withCategoryPath,
} from "../core/categoryTree";
import type { Category } from "../types";

/**
 * Categories come from a decofile a human types into, so every walk over
 * `parentSlug` has to survive garbage: a slug pointing at nothing, at itself,
 * or around a cycle. None of these may hang a request.
 */
const cat = (slug: string, parentSlug?: string): Category => ({
  name: slug.toUpperCase(),
  slug,
  ...(parentSlug ? { parentSlug } : {}),
});

const slugsOf = (chain: Category[] | null) => chain?.map((c) => c.slug) ?? null;

// ---------------------------------------------------------------------------
// ancestorsOf / indexCategories
// ---------------------------------------------------------------------------
describe("ancestorsOf", () => {
  it("returns the chain root first", () => {
    const categories = [cat("root"), cat("mid", "root"), cat("leaf", "mid")];
    const chain = ancestorsOf("leaf", indexCategories(categories));

    expect(slugsOf(chain)).toEqual(["root", "mid", "leaf"]);
    expect(categoryPathname(chain as Category[])).toEqual("root/mid/leaf");
  });

  it("returns null for an unknown slug", () => {
    expect(ancestorsOf("ghost", indexCategories([cat("root")]))).toEqual(null);
  });

  it("yields no chain on a cycle instead of looping", () => {
    const categories = [cat("a", "b"), cat("b", "a")];
    // Walking up from `a` reaches `b`, whose parent is `a` again. The visited set
    // stops the walk; the chain is reported as unusable rather than truncated,
    // because a truncated one would name a canonical URL missing its top.
    expect(ancestorsOf("a", indexCategories(categories))).toEqual(null);
  });

  it("treats a self-referencing category as a root", () => {
    expect(slugsOf(ancestorsOf("a", indexCategories([cat("a", "a")])))).toEqual(["a"]);
  });

  it("stops the walk on a dangling parentSlug", () => {
    const categories = [cat("leaf", "does-not-exist")];
    expect(slugsOf(ancestorsOf("leaf", indexCategories(categories)))).toEqual(["leaf"]);
  });

  it("rejects a chain deeper than MAX_CATEGORY_DEPTH", () => {
    const chainOf = (length: number) =>
      Array.from({ length }, (_, i) => cat(`c${i}`, i === 0 ? undefined : `c${i - 1}`));

    const deepest = chainOf(MAX_CATEGORY_DEPTH);
    expect(ancestorsOf(`c${MAX_CATEGORY_DEPTH - 1}`, indexCategories(deepest))?.length).toEqual(
      MAX_CATEGORY_DEPTH,
    );

    // One level past the ceiling: reporting the truncated chain would hand the
    // canonical URL a path missing its topmost segments, so it reports nothing.
    const tooDeep = chainOf(MAX_CATEGORY_DEPTH + 1);
    expect(ancestorsOf(`c${MAX_CATEGORY_DEPTH}`, indexCategories(tooDeep))).toEqual(null);
  });
});

describe("indexCategories", () => {
  it("resolves duplicated slugs to the first record", () => {
    const first: Category = { name: "First", slug: "dup" };
    const second: Category = { name: "Second", slug: "dup", parentSlug: "dup" };
    const index = indexCategories([first, second]);

    expect(index.get("dup")?.name).toEqual("First");
    expect(index.size).toEqual(1);
  });
});

// ---------------------------------------------------------------------------
// descendantSlugs / childrenOf
// ---------------------------------------------------------------------------
describe("descendantSlugs", () => {
  it("collects the whole subtree, itself included", () => {
    const categories = [
      cat("root"),
      cat("a", "root"),
      cat("b", "root"),
      cat("a1", "a"),
      cat("other"),
    ];

    expect(descendantSlugs("root", categories).sort()).toEqual(["a", "a1", "b", "root"]);
  });

  it("stays finite over a cycle", () => {
    const categories = [cat("a", "b"), cat("b", "a")];
    expect(descendantSlugs("a", categories).sort()).toEqual(["a", "b"]);
  });

  it("of an unknown slug is just the slug", () => {
    expect(descendantSlugs("ghost", [cat("root")])).toEqual(["ghost"]);
  });
});

describe("childrenOf", () => {
  it("returns direct children, name sorted", () => {
    const categories = [
      cat("root"),
      cat("zeta", "root"),
      cat("alpha", "root"),
      cat("deep", "alpha"),
    ];

    expect(childrenOf("root", categories).map((c) => c.slug)).toEqual(["alpha", "zeta"]);
  });
});

// ---------------------------------------------------------------------------
// withCategoryPath
// ---------------------------------------------------------------------------
describe("withCategoryPath", () => {
  it("rewrites the requested path with the real chain", () => {
    const chain = [cat("root"), cat("leaf", "root")];

    // A request that reached the child through a flat path still gets the one
    // canonical URL, so Google consolidates instead of seeing duplicates.
    expect(
      withCategoryPath("https://x.com/blog/leaf?page=2", chain, { requested: ["leaf"] }),
    ).toEqual("https://x.com/blog/root/leaf");
    expect(
      withCategoryPath("https://x.com/blog/wrong/leaf", chain, { requested: ["wrong", "leaf"] }),
    ).toEqual("https://x.com/blog/root/leaf");
  });

  it("declines when the slug isn't in the path", () => {
    const chain = [cat("root"), cat("leaf", "root")];

    // A listing hardcoded to a category on a plain /blog route: the pathname has
    // no category segment, so rewriting it would strip the route prefix and
    // point the canonical at a page that doesn't exist.
    expect(withCategoryPath("https://x.com/blog", chain, { requested: ["leaf"] })).toEqual(null);
    expect(withCategoryPath("https://x.com/blog/other", chain, { requested: ["leaf"] })).toEqual(
      null,
    );
    expect(withCategoryPath("https://x.com/blog/leaf", chain, {})).toEqual(null);
  });

  it("keeps a trailing post slug", () => {
    const chain = [cat("root"), cat("leaf", "root")];
    const knownSlugs = new Set(["root", "leaf"]);

    expect(
      withCategoryPath("https://x.com/blog/leaf/my-post", chain, {
        knownSlugs,
        trailing: "my-post",
      }),
    ).toEqual("https://x.com/blog/root/leaf/my-post");
    // A post route with no category segment keeps its own URL: injecting the
    // chain would canonicalize to a path the site never serves.
    expect(
      withCategoryPath("https://x.com/blog/my-post", chain, { knownSlugs, trailing: "my-post" }),
    ).toEqual(null);
    // The categories collection failed to load, so nothing is a known slug —
    // same outcome, rather than doubling the segment already in the path.
    expect(
      withCategoryPath("https://x.com/blog/leaf/my-post", chain, {
        knownSlugs: new Set<string>(),
        trailing: "my-post",
      }),
    ).toEqual(null);
  });

  it("rewrites nothing with an empty chain", () => {
    expect(withCategoryPath("https://x.com/blog/leaf?page=2", [], { requested: ["leaf"] })).toEqual(
      null,
    );
  });
});
