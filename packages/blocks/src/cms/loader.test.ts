import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDraftOverrideGetter } from "./draftSource";
import {
  findPageByPath,
  getPageIndex,
  loadBlocks,
  matchPath,
  setBlocks,
  setPageSource,
  withBlocksOverride,
  withDraftBlocks,
} from "./loader";

// Mirrors the behavior of the original deco-cx/deco Fresh framework
// (runtime/features/render.tsx), which uses native `URLPattern` directly
// and returns `result.pathname.groups`. Splats become numbered groups
// ("0", "1", …) — there is no `_splat` rename.

describe("matchPath", () => {
  describe("literal segments", () => {
    it("matches the root path", async () => {
      expect(matchPath("/", "/")).toEqual({});
    });

    it("matches exact literal paths", async () => {
      expect(matchPath("/foo/bar", "/foo/bar")).toEqual({});
    });

    it("returns null when literals differ", async () => {
      expect(matchPath("/foo/bar", "/foo/baz")).toBeNull();
    });

    it("returns null when literal-only pattern does not span the whole URL", async () => {
      expect(matchPath("/foo", "/foo/bar")).toBeNull();
    });
  });

  describe("named params (:slug)", () => {
    it("captures a single param", async () => {
      expect(matchPath("/foo/:slug", "/foo/sabonete")).toEqual({
        slug: "sabonete",
      });
    });

    it("captures a param sandwiched between literals (VTEX PDP)", async () => {
      expect(matchPath("/produto/:slug/p", "/produto/sabonete/p")).toEqual({
        slug: "sabonete",
      });
    });

    it("returns null when the URL is shorter than the pattern", async () => {
      expect(matchPath("/foo/:slug", "/foo")).toBeNull();
    });
  });

  describe("trailing splat (*)", () => {
    it("captures the rest as group '0'", async () => {
      expect(matchPath("/*", "/foo/bar")).toEqual({ "0": "foo/bar" });
    });

    it("matches root with empty splat", async () => {
      expect(matchPath("/*", "/")).toEqual({ "0": "" });
    });

    it("captures the remainder under a prefix", async () => {
      expect(matchPath("/foo/*", "/foo/bar/baz")).toEqual({ "0": "bar/baz" });
    });

    // Intentional bug fix: the previous custom matchPath accidentally matched
    // `/foo` against `/foo/*` due to its naive split("/") logic, which also
    // mis-handled trailing slashes. Native URLPattern (and the Fresh original)
    // require at least one segment after `/foo/`.
    it("does NOT match the bare prefix without a trailing segment", async () => {
      expect(matchPath("/foo/*", "/foo")).toBeNull();
    });
  });

  describe("URLPattern optional groups ({...}?)", () => {
    // Patterns emitted by the deco-cx admin / present in production CMS data.
    // These are the cases that issue #213 documents as broken.

    it("matches with the optional group present", async () => {
      expect(matchPath("/{granado/}?*", "/granado/perfumaria")).toEqual({
        "0": "perfumaria",
      });
    });

    it("matches with the optional group absent", async () => {
      expect(matchPath("/{granado/}?*", "/perfumaria")).toEqual({
        "0": "perfumaria",
      });
    });

    it("matches root when optional prefix and splat collapse to empty", async () => {
      expect(matchPath("/{granado/}?*", "/")).toEqual({ "0": "" });
    });

    it("matches with an optional prefix before a literal segment", async () => {
      expect(matchPath("/{granado/}?campanhas/*", "/granado/campanhas/destaques-2023")).toEqual({
        "0": "destaques-2023",
      });
      expect(matchPath("/{granado/}?campanhas/*", "/campanhas/destaques-2023")).toEqual({
        "0": "destaques-2023",
      });
    });

    it("matches an optional suffix group present and absent", async () => {
      expect(matchPath("/black-friday{/70-off}?", "/black-friday")).toEqual({});
      expect(matchPath("/black-friday{/70-off}?", "/black-friday/70-off")).toEqual({});
    });
  });

  describe("error tolerance", () => {
    it("returns null for malformed patterns instead of throwing", async () => {
      expect(() => matchPath("/[invalid", "/anything")).not.toThrow();
      expect(matchPath("/[invalid", "/anything")).toBeNull();
    });

    // Node <= 22 has no URLPattern global. The malformed-pattern try/catch
    // above must NOT absorb that ReferenceError — a missing API has to fail
    // loudly at first match, not degrade into every CMS page silently
    // returning null (which renders as sitewide 404s).
    it("throws a descriptive error when the runtime lacks URLPattern", async () => {
      const g = globalThis as { URLPattern?: unknown };
      const saved = g.URLPattern;
      // biome-ignore lint/performance/noDelete: restoring exact global state
      delete g.URLPattern;
      try {
        expect(() => matchPath("/foo/:slug", "/foo/bar")).toThrow(/URLPattern.*Node\.js >= 24/s);
      } finally {
        if (saved !== undefined) g.URLPattern = saved;
      }
    });
  });
});

describe("findPageByPath specificity", () => {
  beforeEach(() => {
    setBlocks({
      "pages-bf": {
        name: "Black Friday",
        path: "/black-friday",
        sections: [],
      },
      "pages-bf-splat": {
        name: "Black Friday with optional suffix",
        path: "/black-friday{/70-off}?",
        sections: [],
      },
      "pages-pdp-plp": {
        name: "PDP & PLP",
        path: "/{granado/}?*",
        sections: [],
      },
      "pages-product": {
        name: "Product",
        path: "/produto/:slug/p",
        sections: [],
      },
    });
  });

  afterEach(() => {
    setBlocks({});
  });

  it("prefers an exact literal over an optional-group splat", async () => {
    const match = await findPageByPath("/black-friday");
    expect(match?.blockKey).toBe("pages-bf");
  });

  it("prefers the home page over an optional-group splat catch-all", async () => {
    // Regression: /{granado/}?* matches "/" and was out-ranking the home
    // because the `{granado` segment counted as a param. The home block
    // is a literal-only `/` path and must always win.
    setBlocks({
      "pages-home": {
        name: "Home",
        path: "/",
        sections: [],
      },
      "pages-pdp-plp": {
        name: "PDP & PLP",
        path: "/{granado/}?*",
        sections: [],
      },
    });
    const match = await findPageByPath("/");
    expect(match?.blockKey).toBe("pages-home");
  });

  it("falls back to the splat page for unknown URLs", async () => {
    const match = await findPageByPath("/perfumaria");
    expect(match?.blockKey).toBe("pages-pdp-plp");
    expect(match?.params).toEqual({ "0": "perfumaria" });
  });

  it("matches the param-bearing route ahead of the splat catch-all", async () => {
    const match = await findPageByPath("/produto/sabonete/p");
    expect(match?.blockKey).toBe("pages-product");
    expect(match?.params).toEqual({ slug: "sabonete" });
  });

  it("returns null when no page matches", async () => {
    setBlocks({
      "pages-only-bf": {
        name: "Black Friday",
        path: "/black-friday",
        sections: [],
      },
    });
    expect(await findPageByPath("/nope")).toBeNull();
  });
});

describe("loadBlocks draft override — key percent-encoding", () => {
  // The published decofile encodes special characters in block keys
  // (`pages-Home%20(principal)-1`); the Studio draft emits them raw
  // (`pages-Home (principal)-1`). Under snapshot semantics the draft REPLACES
  // the file-backed base wholesale, so an encoded/raw twin pair can never
  // coexist — these regression tests (from the merge era, when ~73% of
  // casaevideo's pages silently ignored drafts) now pin that property.

  afterEach(() => {
    setBlocks({});
    setDraftOverrideGetter(() => undefined);
  });

  it("replaces an encoded base key with its raw-encoded draft twin (home)", async () => {
    setBlocks({
      "pages-Home%20(principal)-1": {
        name: "Home",
        path: "/",
        sections: [{ __resolveType: "published" }],
      },
    });
    setDraftOverrideGetter(() => ({
      "pages-Home (principal)-1": {
        name: "Home",
        path: "/",
        sections: [{ __resolveType: "draft" }],
      },
    }));

    // Exactly one page for "/" survives the merge — no encoded/raw duplicate.
    const pageBlocks = Object.keys(loadBlocks()).filter((k) => k.startsWith("pages-"));
    expect(pageBlocks).toHaveLength(1);

    const match = await findPageByPath("/");
    const sections = match?.page.sections as Array<{ __resolveType: string }>;
    expect(sections[0].__resolveType).toBe("draft");
  });

  it("still replaces a plain (unescaped) base key", async () => {
    setBlocks({
      "pages-disney-1": {
        name: "Disney",
        path: "/disney",
        sections: [{ __resolveType: "published" }],
      },
    });
    setDraftOverrideGetter(() => ({
      "pages-disney-1": {
        name: "Disney",
        path: "/disney",
        sections: [{ __resolveType: "draft" }],
      },
    }));

    const match = await findPageByPath("/disney");
    const sections = match?.page.sections as Array<{ __resolveType: string }>;
    expect(sections[0].__resolveType).toBe("draft");
  });

  it("a null draft value removes the encoded base twin too", async () => {
    setBlocks({
      "pages-Home%20(principal)-1": {
        name: "Home",
        path: "/",
        sections: [{ __resolveType: "published" }],
      },
    });
    setDraftOverrideGetter(() => ({
      "pages-Home (principal)-1": null,
    }));

    expect(await findPageByPath("/")).toBeNull();
    const pageBlocks = Object.keys(loadBlocks()).filter((k) => k.startsWith("pages-"));
    expect(pageBlocks).toHaveLength(0);
  });
});

describe("loadBlocks draft snapshot semantics", () => {
  afterEach(() => {
    setBlocks({});
    setDraftOverrideGetter(() => undefined);
  });

  it("a block absent from the draft is deleted — the draft is the complete truth", async () => {
    setBlocks({
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
      "pages-old-2": { name: "Old", path: "/old", sections: [{}] },
    });
    setDraftOverrideGetter(() => ({
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
    }));

    const keys = Object.keys(loadBlocks());
    expect(keys).toEqual(["pages-home-1"]);
    expect(await findPageByPath("/old")).toBeNull();
  });

  it("synthetic CSV-redirect base blocks survive the snapshot", async () => {
    setBlocks({
      "__csv_redirects__bulk.csv": { redirects: [{ from: "/a", to: "/b" }] },
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
    });
    setDraftOverrideGetter(() => ({
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
    }));

    const blocks = loadBlocks();
    expect(blocks["__csv_redirects__bulk.csv"]).toEqual({
      redirects: [{ from: "/a", to: "/b" }],
    });
  });

  it("withDraftBlocks applies snapshot semantics; withBlocksOverride keeps merge", async () => {
    setBlocks({
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
      "pages-other-2": { name: "Other", path: "/other", sections: [{}] },
    });
    const draft = {
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
    };

    // Snapshot: the base-only block is gone.
    withDraftBlocks(draft, () => {
      expect(Object.keys(loadBlocks())).toEqual(["pages-home-1"]);
    });

    // Merge (admin partial payloads): the base-only block survives.
    withBlocksOverride(draft, () => {
      expect(Object.keys(loadBlocks()).sort()).toEqual(["pages-home-1", "pages-other-2"]);
    });
  });

  it("an explicit scope wins over the ambient draft", async () => {
    setBlocks({ "pages-home-1": { name: "Home", path: "/", sections: [{}] } });
    setDraftOverrideGetter(() => ({
      "pages-ambient-9": { name: "A", path: "/a", sections: [{}] },
    }));

    withDraftBlocks({ "pages-scoped-3": { name: "S", path: "/s", sections: [{}] } }, () => {
      expect(Object.keys(loadBlocks())).toEqual(["pages-scoped-3"]);
    });
  });
});

describe("PageSource — pages served from outside the isolate", () => {
  const home = { name: "Home", path: "/", sections: [] };
  const pdp = { name: "PDP", path: "/produto/:slug/p", sections: [] };
  const splat = { name: "Catch", path: "/*", sections: [] };

  function source(loaded: string[]) {
    return {
      // Deliberately least-specific-first: setPageSource must sort, because a
      // decofile's key order is not routing order.
      index: [
        { key: "pages-splat", path: splat.path },
        { key: "pages-pdp", path: pdp.path },
        { key: "pages-home", path: home.path },
      ],
      load: (key: string) => {
        loaded.push(key);
        const map: Record<string, unknown> = {
          "pages-home": home,
          "pages-pdp": pdp,
          "pages-splat": splat,
        };
        return Promise.resolve((map[key] ?? null) as never);
      },
    };
  }

  beforeEach(() => {
    // Non-page blocks only — this is what a split isolate actually holds.
    setBlocks({ Site: { name: "s" } });
  });

  afterEach(() => setPageSource(null));

  it("routes by specificity and fetches exactly one page body", async () => {
    const loaded: string[] = [];
    setPageSource(source(loaded));

    await expect(findPageByPath("/produto/sabonete/p")).resolves.toMatchObject({
      blockKey: "pages-pdp",
      params: { slug: "sabonete" },
    });
    // The splat also matches; it must never be fetched, and neither may any
    // page that lost the specificity race.
    expect(loaded).toEqual(["pages-pdp"]);
  });

  it("keeps the pages out of memory", async () => {
    setPageSource(source([]));
    await findPageByPath("/");
    expect(Object.keys(loadBlocks())).toEqual(["Site"]);
  });

  it("skips an index entry whose page vanished from the source", async () => {
    const loaded: string[] = [];
    setPageSource({
      index: [
        { key: "pages-gone", path: "/" },
        { key: "pages-home", path: "/{x/}?*" },
      ],
      load: (key: string) => {
        loaded.push(key);
        return Promise.resolve(key === "pages-home" ? (home as never) : null);
      },
    });

    // A GC'd page must fall through to the next match, not 404 the request.
    await expect(findPageByPath("/")).resolves.toMatchObject({ blockKey: "pages-home" });
    expect(loaded).toEqual(["pages-gone", "pages-home"]);
  });

  it("ignores the source inside a preview override and scans memory instead", async () => {
    const loaded: string[] = [];
    setPageSource(source(loaded));

    const draft = { name: "Draft home", path: "/", sections: [] };
    const match = await withBlocksOverride({ "pages-home": draft }, () => findPageByPath("/"));

    // The editor is previewing THIS page; routing to the published one would
    // make the preview silently show the wrong content.
    expect(match?.page).toEqual(draft);
    expect(loaded).toEqual([]);
  });

  it("getPageIndex reports the source's pages without loading any", () => {
    const loaded: string[] = [];
    setPageSource(source(loaded));
    // Sorted by specificity, not decofile order: two literals beat the bare
    // "/" root, which in turn beats the "/*" catch-all.
    expect(getPageIndex().map((e) => e.key)).toEqual(["pages-pdp", "pages-home", "pages-splat"]);
    expect(loaded).toEqual([]);
  });
});
