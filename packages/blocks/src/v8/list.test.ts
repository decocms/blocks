// @vitest-environment node
/** client.list (api-reference#client-list-type-options and routing.mdx). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Blocks, Page, Snapshot } from "./types";

beforeEach(() => resetForTests());

function client(blocks: Blocks = docsBlocks(), content: Snapshot = docsSnapshot()) {
  return createCMS({ blocks, content }).forRelease();
}

interface Post {
  name: string;
  path: string;
  date: string;
}

function blog(): Snapshot {
  const posts: Record<string, unknown> = {};
  const dates = ["2026-09-01", "2026-07-15", "2026-12-25", "2026-08-30"];
  ["Zeta", "Alpha", "Mid", "Beta"].forEach((name, i) => {
    posts[name] = {
      __resolveType: "post",
      name,
      path: `/blog/${name.toLowerCase()}`,
      date: dates[i],
    };
  });
  return {
    revision: "blog",
    blocks: { ...posts, Other: { __resolveType: "page", name: "x", path: "/x", sections: [] } },
  };
}

describe("client.list", () => {
  it("returns every saved block of the type, sorted by name, as saved (nothing runs)", async () => {
    const post = vi.fn();
    const [posts, error] = await client({ post }, blog()).list<Post>("post");
    expect(error).toBeNull();
    expect(posts?.map((p) => p.name)).toEqual(["Alpha", "Beta", "Mid", "Zeta"]);
    expect(posts?.[0]).toEqual({
      __resolveType: "post",
      name: "Alpha",
      path: "/blog/alpha",
      date: "2026-07-15",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("sorts by plain code-unit order, the same on every server and locale", async () => {
    const names = ["b", "B", "a", "Ä", "_x", "10", "9"];
    const content: Snapshot = {
      revision: "r",
      blocks: Object.fromEntries(names.map((name) => [name, { __resolveType: "t", name }])),
    };
    const [entries] = await client({}, content).list<{ name: string }>("t");
    expect(entries?.map((e) => e.name)).toEqual(["10", "9", "B", "_x", "a", "b", "Ä"]);
  });

  it("returns pages as saved: seo and sections still blocks", async () => {
    const [pages] = await client().list<Record<string, unknown>>("page");
    expect(pages?.map((p) => p.name)).toEqual(["Home", "Summer campaign"]);
    const summer = pages?.[1];
    expect(summer?.seo).toEqual({
      __resolveType: "seo",
      title: "Sunny!",
      description: "Light layers for long days.",
    });
  });

  it("where, sort and limit (the api-reference example)", async () => {
    const today = "2026-10-03";
    const [posts] = await client({}, blog()).list<Post>("post", {
      where: (p) => p.date <= today,
      sort: (a, b) => b.date.localeCompare(a.date),
      limit: 2,
    });
    expect(posts?.map((p) => p.name)).toEqual(["Zeta", "Beta"]);
  });

  it("limit 0 returns nothing; a negative limit is ignored", async () => {
    expect((await client({}, blog()).list("post", { limit: 0 }))[0]).toEqual([]);
    expect((await client({}, blog()).list("post", { limit: -1 }))[0]).toHaveLength(4);
  });

  it("run: true resolves every entry: list('page', { run: true }) returns ready pages", async () => {
    const [pages, error] = await client().list<Page>("page", { run: true });
    expect(error).toBeNull();
    expect(pages?.map((p) => p.name)).toEqual(["Home", "Summer campaign"]);
    expect(pages?.[1]?.seo).toEqual({
      title: "Sunny!",
      description: "Light layers for long days.",
    });
  });

  it("run: true fails with UNKNOWN_BLOCK when the type isn't in the block map, naming the entry", async () => {
    const [value, error] = await client({}, blog()).list("post", { run: true });
    expect(value).toBeNull();
    expect(error).toMatchObject({ code: "UNKNOWN_BLOCK", path: ["Alpha"] });
  });

  it("run: true leaves out entries that resolve to undefined", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {
        A: { __resolveType: "maybe", keep: true },
        B: { __resolveType: "maybe", keep: false },
      },
    };
    const maybe = ({ keep }: { keep: boolean }) => (keep ? "kept" : undefined);
    expect(await client({ maybe }, content).list("maybe", { run: true })).toEqual([["kept"], null]);
  });

  it("includes entries saved under an alias of the type", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {
        New: { __resolveType: "page", name: "New", path: "/new", sections: [] },
        Old: { __resolveType: "website/pages/Page.tsx", name: "Old", path: "/old", sections: [] },
        Unrelated: { __resolveType: "post", name: "P", path: "/p" },
      },
      aliases: { "website/pages/Page.tsx": "page" },
    };
    const [pages] = await client({}, content).list<Page>("page");
    expect(pages?.map((p) => p.name)).toEqual(["New", "Old"]);
    const [byAlias] = await client({}, content).list<Page>("website/pages/Page.tsx");
    expect(byAlias?.map((p) => p.name)).toEqual(["New", "Old"]);
  });

  it("an unknown type lists nothing", async () => {
    expect(await client().list("nothing")).toEqual([[], null]);
  });

  it("expands references inside entries", async () => {
    const [pages] = await client().list<Record<string, unknown>>("page", {
      where: (p) => p.name === "Home",
    });
    expect(pages?.[0]?.sections).toEqual([
      {
        __resolveType: "product-card",
        title: "Summer collection",
        product: { __resolveType: "catalog-product", slug: "summer-shirt" },
      },
    ]);
  });

  it("returns a CYCLE inside an entry as an error", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {
        P: { __resolveType: "page", sections: [{ __resolveType: "Loop" }] },
        Loop: { __resolveType: "Loop" },
      },
    };
    const [, error] = await client({}, content).list("page");
    expect(error?.code).toBe("CYCLE");
  });
});
