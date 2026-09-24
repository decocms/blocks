import { describe, expect, it } from "vitest";
import {
  loadRedirects,
  matchExactRedirect,
  matchPatternRedirect,
  matchRedirect,
  splitExactRedirects,
} from "./redirects";

/**
 * Exact rules move to their own KV keys; globs stay in the decofile because
 * they must be scanned in order and can never be a key lookup.
 *
 * The invariant that matters: whatever leaves the decofile must be recoverable
 * from the extracted list, and whatever stays must still match the same way.
 */
describe("splitExactRedirects", () => {
  it("extracts exact rules and drops them from the block", () => {
    const { blocks, exact } = splitExactRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [
          { from: "/old", to: "/new", type: "permanent" },
          { from: "/tmp", to: "/other" },
        ],
      },
    });

    expect(exact).toEqual([
      { path: "/old", to: "/new", status: 301 },
      { path: "/tmp", to: "/other", status: 302 },
    ]);
    // Block had nothing but exact rules ⇒ gone entirely, not an empty husk.
    expect(blocks.r).toBeUndefined();
  });

  it("keeps glob rules in the decofile", () => {
    const { blocks, exact } = splitExactRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [
          { from: "/old/*", to: "/new/*" },
          { from: "/exact", to: "/x" },
        ],
      },
    });

    expect(exact.map((e) => e.path)).toEqual(["/exact"]);
    expect((blocks.r as { redirects: unknown[] }).redirects).toEqual([
      { from: "/old/*", to: "/new/*" },
    ]);
  });

  it("normalizes the path to the KV key contract", () => {
    const { exact } = splitExactRedirects({
      r: {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "https://site.com/Old/", to: "/new" },
      },
    });
    // Origin stripped, trailing slash dropped, lower-cased — whatever the
    // writer keys by, the request-time lookup must produce byte for byte.
    expect(exact).toEqual([{ path: "/old", to: "/new", status: 302 }]);
  });

  it("drops the singular `redirect` field when rebuilding a block", () => {
    // Otherwise the extracted rule would be silently reintroduced.
    const { blocks } = splitExactRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirect: { from: "/a", to: "/b" },
        redirects: [{ from: "/glob/*", to: "/g" }],
      },
    });
    expect(blocks.r).not.toHaveProperty("redirect");
  });

  it("leaves non-redirect blocks untouched, by identity", () => {
    const page = { __resolveType: "website/pages/Page.tsx", sections: [] };
    const { blocks } = splitExactRedirects({ page });
    expect(blocks.page).toBe(page);
  });

  it("dedupes by path, last rule winning — same as loadRedirects", () => {
    const input = {
      a: { __resolveType: "website/loaders/redirects.ts", redirects: [{ from: "/x", to: "/1" }] },
      b: { __resolveType: "website/loaders/redirects.ts", redirects: [{ from: "/x", to: "/2" }] },
    };
    expect(splitExactRedirects(input).exact).toEqual([{ path: "/x", to: "/2", status: 302 }]);
    expect(loadRedirects(input).exact.get("/x")?.to).toBe("/2");
  });

  it("round-trips: nothing matchable is lost", () => {
    const input = {
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [
          { from: "/a", to: "/1", type: "permanent" },
          { from: "/b/*", to: "/2/*" },
        ],
      },
    };
    const before = loadRedirects(input);
    const { blocks, exact } = splitExactRedirects(input);
    const after = loadRedirects(blocks);

    // Exact left the decofile...
    expect(matchRedirect("/a", after)).toBeNull();
    // ...into the extracted list, unchanged.
    expect(exact).toContainEqual({ path: "/a", to: "/1", status: 301 });
    // Globs still match exactly as before.
    expect(matchRedirect("/b/deep", after)).toEqual(matchRedirect("/b/deep", before));
  });
});

describe("matchExactRedirect / matchPatternRedirect", () => {
  const map = loadRedirects({
    r: {
      __resolveType: "website/loaders/redirects.ts",
      redirects: [
        { from: "/shop/*", to: "/store/*" },
        { from: "/shop/sale", to: "/promo", type: "permanent" },
      ],
    },
  });

  it("compose back into matchRedirect unchanged", () => {
    for (const path of ["/shop/sale", "/shop/deep", "/nothing"]) {
      expect(matchExactRedirect(path, map) ?? matchPatternRedirect(path, map)).toEqual(
        matchRedirect(path, map),
      );
    }
  });

  it("splits the two halves so KV can be interleaved between them", () => {
    // The whole reason for the split: with exact rules in KV, "matchRedirect
    // then KV" would let /shop/* win over the exact /shop/sale.
    expect(matchExactRedirect("/shop/sale", map)?.to).toBe("/promo");
    expect(matchPatternRedirect("/shop/sale", map)?.to).toBe("/store/sale");
  });
});
