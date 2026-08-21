import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDraftOverrideGetter } from "./draftSource";
import {
  findPageByPath,
  getSiteBlock,
  getSiteSeo,
  loadBlocks,
  matchPath,
  setBlocks,
  withBlocksOverride,
  withDraftBlocks,
} from "./loader";

// Mirrors the behavior of the original deco-cx/deco Fresh framework
// (runtime/features/render.tsx), which uses native `URLPattern` directly
// and returns `result.pathname.groups`. Splats become numbered groups
// ("0", "1", …) — there is no `_splat` rename.

describe("matchPath", () => {
  describe("literal segments", () => {
    it("matches the root path", () => {
      expect(matchPath("/", "/")).toEqual({});
    });

    it("matches exact literal paths", () => {
      expect(matchPath("/foo/bar", "/foo/bar")).toEqual({});
    });

    it("returns null when literals differ", () => {
      expect(matchPath("/foo/bar", "/foo/baz")).toBeNull();
    });

    it("returns null when literal-only pattern does not span the whole URL", () => {
      expect(matchPath("/foo", "/foo/bar")).toBeNull();
    });
  });

  describe("named params (:slug)", () => {
    it("captures a single param", () => {
      expect(matchPath("/foo/:slug", "/foo/sabonete")).toEqual({
        slug: "sabonete",
      });
    });

    it("captures a param sandwiched between literals (VTEX PDP)", () => {
      expect(matchPath("/produto/:slug/p", "/produto/sabonete/p")).toEqual({
        slug: "sabonete",
      });
    });

    it("returns null when the URL is shorter than the pattern", () => {
      expect(matchPath("/foo/:slug", "/foo")).toBeNull();
    });
  });

  describe("trailing splat (*)", () => {
    it("captures the rest as group '0'", () => {
      expect(matchPath("/*", "/foo/bar")).toEqual({ "0": "foo/bar" });
    });

    it("matches root with empty splat", () => {
      expect(matchPath("/*", "/")).toEqual({ "0": "" });
    });

    it("captures the remainder under a prefix", () => {
      expect(matchPath("/foo/*", "/foo/bar/baz")).toEqual({ "0": "bar/baz" });
    });

    // Intentional bug fix: the previous custom matchPath accidentally matched
    // `/foo` against `/foo/*` due to its naive split("/") logic, which also
    // mis-handled trailing slashes. Native URLPattern (and the Fresh original)
    // require at least one segment after `/foo/`.
    it("does NOT match the bare prefix without a trailing segment", () => {
      expect(matchPath("/foo/*", "/foo")).toBeNull();
    });
  });

  describe("URLPattern optional groups ({...}?)", () => {
    // Patterns emitted by the deco-cx admin / present in production CMS data.
    // These are the cases that issue #213 documents as broken.

    it("matches with the optional group present", () => {
      expect(matchPath("/{granado/}?*", "/granado/perfumaria")).toEqual({
        "0": "perfumaria",
      });
    });

    it("matches with the optional group absent", () => {
      expect(matchPath("/{granado/}?*", "/perfumaria")).toEqual({
        "0": "perfumaria",
      });
    });

    it("matches root when optional prefix and splat collapse to empty", () => {
      expect(matchPath("/{granado/}?*", "/")).toEqual({ "0": "" });
    });

    it("matches with an optional prefix before a literal segment", () => {
      expect(
        matchPath(
          "/{granado/}?campanhas/*",
          "/granado/campanhas/destaques-2023",
        ),
      ).toEqual({
        "0": "destaques-2023",
      });
      expect(
        matchPath("/{granado/}?campanhas/*", "/campanhas/destaques-2023"),
      ).toEqual({
        "0": "destaques-2023",
      });
    });

    it("matches an optional suffix group present and absent", () => {
      expect(matchPath("/black-friday{/70-off}?", "/black-friday")).toEqual({});
      expect(
        matchPath("/black-friday{/70-off}?", "/black-friday/70-off"),
      ).toEqual({});
    });
  });

  describe("error tolerance", () => {
    it("returns null for malformed patterns instead of throwing", () => {
      expect(() => matchPath("/[invalid", "/anything")).not.toThrow();
      expect(matchPath("/[invalid", "/anything")).toBeNull();
    });

    // Node <= 22 has no URLPattern global. The malformed-pattern try/catch
    // above must NOT absorb that ReferenceError — a missing API has to fail
    // loudly at first match, not degrade into every CMS page silently
    // returning null (which renders as sitewide 404s).
    it("throws a descriptive error when the runtime lacks URLPattern", () => {
      const g = globalThis as { URLPattern?: unknown };
      const saved = g.URLPattern;
      // biome-ignore lint/performance/noDelete: restoring exact global state
      delete g.URLPattern;
      try {
        expect(() => matchPath("/foo/:slug", "/foo/bar")).toThrow(
          /URLPattern.*Node\.js >= 24/s,
        );
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

  it("prefers an exact literal over an optional-group splat", () => {
    const match = findPageByPath("/black-friday");
    expect(match?.blockKey).toBe("pages-bf");
  });

  it("prefers the home page over an optional-group splat catch-all", () => {
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
    const match = findPageByPath("/");
    expect(match?.blockKey).toBe("pages-home");
  });

  it("falls back to the splat page for unknown URLs", () => {
    const match = findPageByPath("/perfumaria");
    expect(match?.blockKey).toBe("pages-pdp-plp");
    expect(match?.params).toEqual({ "0": "perfumaria" });
  });

  it("matches the param-bearing route ahead of the splat catch-all", () => {
    const match = findPageByPath("/produto/sabonete/p");
    expect(match?.blockKey).toBe("pages-product");
    expect(match?.params).toEqual({ slug: "sabonete" });
  });

  it("returns null when no page matches", () => {
    setBlocks({
      "pages-only-bf": {
        name: "Black Friday",
        path: "/black-friday",
        sections: [],
      },
    });
    expect(findPageByPath("/nope")).toBeNull();
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

  it("replaces an encoded base key with its raw-encoded draft twin (home)", () => {
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
    const pageBlocks = Object.keys(loadBlocks()).filter((k) =>
      k.startsWith("pages-"),
    );
    expect(pageBlocks).toHaveLength(1);

    const match = findPageByPath("/");
    const sections = match?.page.sections as Array<{ __resolveType: string }>;
    expect(sections[0].__resolveType).toBe("draft");
  });

  it("still replaces a plain (unescaped) base key", () => {
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

    const match = findPageByPath("/disney");
    const sections = match?.page.sections as Array<{ __resolveType: string }>;
    expect(sections[0].__resolveType).toBe("draft");
  });

  it("a null draft value removes the encoded base twin too", () => {
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

    expect(findPageByPath("/")).toBeNull();
    const pageBlocks = Object.keys(loadBlocks()).filter((k) =>
      k.startsWith("pages-"),
    );
    expect(pageBlocks).toHaveLength(0);
  });
});

describe("loadBlocks draft snapshot semantics", () => {
  afterEach(() => {
    setBlocks({});
    setDraftOverrideGetter(() => undefined);
  });

  it("a block absent from the draft is deleted — the draft is the complete truth", () => {
    setBlocks({
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
      "pages-old-2": { name: "Old", path: "/old", sections: [{}] },
    });
    setDraftOverrideGetter(() => ({
      "pages-home-1": { name: "Home", path: "/", sections: [{}] },
    }));

    const keys = Object.keys(loadBlocks());
    expect(keys).toEqual(["pages-home-1"]);
    expect(findPageByPath("/old")).toBeNull();
  });

  it("synthetic CSV-redirect base blocks survive the snapshot", () => {
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

  it("withDraftBlocks applies snapshot semantics; withBlocksOverride keeps merge", () => {
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
      expect(Object.keys(loadBlocks()).sort()).toEqual([
        "pages-home-1",
        "pages-other-2",
      ]);
    });
  });

  it("an explicit scope wins over the ambient draft", () => {
    setBlocks({ "pages-home-1": { name: "Home", path: "/", sections: [{}] } });
    setDraftOverrideGetter(() => ({
      "pages-ambient-9": { name: "A", path: "/a", sections: [{}] },
    }));

    withDraftBlocks(
      { "pages-scoped-3": { name: "S", path: "/s", sections: [{}] } },
      () => {
        expect(Object.keys(loadBlocks())).toEqual(["pages-scoped-3"]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Site block key casing
// ---------------------------------------------------------------------------

/**
 * The site block's key comes from its filename in `.deco/blocks/`, so real
 * sites ship both spellings: `site.json` -> "site", `Site.json` -> "Site".
 *
 * Reading `blocks["Site"]` directly returns `undefined` on the lowercase ones —
 * no error, no warning, the feature just silently does nothing. That shipped
 * twice: PR #479 fixed `getSiteSeo` and the `?asJson` SEO merge but missed the
 * `?renderJson` `sectionsToIgnore` lookup, which stayed dead in production
 * (a live site had three entries configured and none applied).
 *
 * If this fails, do not "fix" it by special-casing one caller — every site-block
 * read must go through `getSiteBlock()`.
 */
describe("getSiteBlock — key casing", () => {
  afterEach(() => setBlocks({}));

  it('finds the block under the capitalized "Site" key', () => {
    setBlocks({ Site: { seo: { title: "Capitalized" } } });
    expect(getSiteBlock()).toEqual({ seo: { title: "Capitalized" } });
    expect(getSiteSeo().title).toBe("Capitalized");
  });

  it('finds the block under the lowercase "site" key', () => {
    setBlocks({ site: { seo: { title: "Lowercase" } } });
    expect(getSiteBlock()).toEqual({ seo: { title: "Lowercase" } });
    expect(getSiteSeo().title).toBe("Lowercase");
  });

  it("prefers the capitalized key when a decofile somehow has both", () => {
    setBlocks({ Site: { seo: { title: "Capitalized" } }, site: { seo: { title: "Lowercase" } } });
    expect(getSiteSeo().title).toBe("Capitalized");
  });

  it("returns undefined when there is no site block at all", () => {
    setBlocks({ "pages-home": { name: "Home", sections: [] } });
    expect(getSiteBlock()).toBeUndefined();
    expect(getSiteSeo()).toEqual({});
  });

  it("exposes renderJson.sectionsToIgnore from a lowercase site block", () => {
    // The exact shape `workerEntry`'s ?renderJson path reads — the call site
    // that PR #479 missed.
    setBlocks({ site: { renderJson: { sectionsToIgnore: ["SeoV2.tsx"] } } });
    const rj = getSiteBlock()?.renderJson as { sectionsToIgnore?: string[] };
    expect(rj?.sectionsToIgnore).toEqual(["SeoV2.tsx"]);
  });
});
