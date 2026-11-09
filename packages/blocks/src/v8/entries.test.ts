// @vitest-environment node
/**
 * client.entries on local content (a snapshot, a custom loader, a draft over
 * it): the same index-only answer a hosted release gives (see pin.test.ts for
 * the CDN, where it fetches no block body).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { localIndex } from "./contentIndex";
import { docsBlocks, docsSnapshot, fakeStudio } from "./testFixtures";
import type { Blocks, Snapshot } from "./types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function client(blocks: Blocks = docsBlocks(), content: Snapshot = docsSnapshot()) {
  return createCMS({ blocks, content }).forRelease();
}

function blog(): Snapshot {
  const posts: Record<string, unknown> = {};
  ["Zeta", "Alpha", "Mid", "Beta"].forEach((name) => {
    posts[name] = { __resolveType: "post", name, path: `/blog/${name.toLowerCase()}` };
  });
  return {
    revision: "blog",
    blocks: {
      ...posts,
      Other: {
        __resolveType: "page",
        name: "x",
        path: "/x",
        sections: [{ __resolveType: "Zeta" }],
      },
      Untyped: { title: "no type" },
    },
  };
}

describe("client.entries", () => {
  it("names every saved block of the type in code-unit order, running and expanding nothing", async () => {
    const post = vi.fn();
    const [posts, error] = await client({ post }, blog()).entries("post");
    expect(error).toBeNull();
    expect(posts?.map((p) => p.name)).toEqual(["Alpha", "Beta", "Mid", "Zeta"]);
    expect(posts?.[0]).toEqual({
      name: "Alpha",
      type: "post",
      path: "/blog/alpha",
      refs: [],
      noIndex: false,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("without a type, every typed entry; refs are the saved blocks it references", async () => {
    const [all] = await client({}, blog()).entries();
    expect(all?.map((e) => e.name)).toEqual(["Alpha", "Beta", "Mid", "Other", "Zeta"]);
    expect(all?.find((e) => e.name === "Other")?.refs).toEqual(["Zeta"]);
  });

  it("matches a type through its aliases and the legacy names, and reports the mapped type", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {
        New: { __resolveType: "page", path: "/new", sections: [] },
        Old: { __resolveType: "website/pages/Page.tsx", path: "/old", sections: [] },
        Article: { __resolveType: "article", path: "/a" },
      },
      aliases: { article: "post" },
    };
    const c = client({}, content);
    const [pages] = await c.entries("page");
    expect(pages?.map((p) => [p.name, p.type])).toEqual([
      ["New", "page"],
      ["Old", "page"],
    ]);
    expect((await c.entries("website/pages/Page.tsx"))[0]).toBe(pages);
    expect((await c.entries("article"))[0]?.map((p) => [p.name, p.type])).toEqual([
      ["Article", "post"],
    ]);
  });

  it("an unknown type, or a type that isn't a string, gives []", async () => {
    expect(await client().entries("nothing")).toEqual([[], null]);
    expect(await client().entries(3 as unknown as string)).toEqual([[], null]);
  });

  it("noIndex: an inline seo, a saved SEO block (a chain of them), an override, and only on pages", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {
        Open: { __resolveType: "page", path: "/" },
        Inline: {
          __resolveType: "page",
          path: "/i",
          seo: { __resolveType: "seo", noIndexing: true },
        },
        Saved: { __resolveType: "page", path: "/s", seo: { __resolveType: "DefaultSeo" } },
        Chained: { __resolveType: "page", path: "/c", seo: { __resolveType: "StagingSeo" } },
        Override: {
          __resolveType: "page",
          path: "/o",
          seo: { __resolveType: "DefaultSeo", noIndexing: false },
        },
        Cycle: { __resolveType: "page", path: "/l", seo: { __resolveType: "LoopSeo" } },
        DefaultSeo: { __resolveType: "seo", noIndexing: true },
        StagingSeo: { __resolveType: "DefaultSeo" },
        LoopSeo: { __resolveType: "LoopSeo" },
        NotAPage: { __resolveType: "post", seo: { noIndexing: true } },
      },
    };
    const [all] = await client({}, content).entries();
    const noIndex = Object.fromEntries((all ?? []).map((e) => [e.name, e.noIndex]));
    expect(noIndex).toEqual({
      Chained: true,
      Cycle: false,
      DefaultSeo: false,
      Inline: true,
      LoopSeo: false,
      NotAPage: false,
      Open: false,
      Override: false,
      Saved: true,
      StagingSeo: false,
    });
  });

  it("local content is indexed at the current meta version", () => {
    expect(localIndex(blog()).metaVersion).toBe(2);
  });

  it("is the same frozen array for the same snapshot and type", async () => {
    const content = blog();
    const cms = createCMS({ blocks: {}, content });
    const [first] = await cms.forRelease().entries("post");
    const [second] = await cms.forRelease().entries("post");
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => (first as unknown as { name: string }[]).push({ name: "x" })).toThrow();
  });

  it("a draft overlays its changes: set adds or replaces an entry (noIndex recomputed), delete removes it", async () => {
    const studio = fakeStudio();
    vi.stubGlobal("fetch", studio.fetch);
    const pointer = studio.draft({
      set: {
        HomePage: { __resolveType: "page", name: "Home", path: "/", seo: { noIndexing: true } },
        NewPost: { __resolveType: "post", path: "/blog/new" },
      },
      delete: ["HelloWorld"],
    });
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [pages] = await cms.forDraft(pointer).entries("page");
    expect(pages?.map((p) => [p.name, p.noIndex])).toEqual([
      ["HomePage", true],
      ["SummerPage", false],
    ]);
    const [posts] = await cms.forDraft(pointer).entries("post");
    expect(posts?.map((p) => p.name)).toEqual(["NewPost"]);
    const [released] = await cms.forRelease().entries("post");
    expect(released?.map((p) => p.name)).toEqual(["HelloWorld"]);
  });
});
