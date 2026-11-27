import { describe, expect, it } from "vitest";
import { withDeco } from "./config.cjs";

// withDeco()'s declared return type is the standard (loosely typed) Next.js
// NextConfig, whose `rewrites`/`transpilePackages` are optional and
// union-typed. The runtime object always has them (withDeco always sets
// them), so tests assert that with `!` / casts rather than loosening the
// public declaration.
describe("withDeco", () => {
  it("adds transpilePackages and no rewrites to a bare config", async () => {
    const cfg = withDeco({});
    expect(cfg.transpilePackages).toEqual(
      expect.arrayContaining(["@decocms/blocks", "@decocms/blocks-admin", "@decocms/nextjs"]),
    );
    // The staff-only admin rewrites (/.decofile, /live/_meta,
    // /live/previews/*) were hard-removed; withDeco must not add any.
    expect(cfg.rewrites).toBeUndefined();
  });

  it("passes a user's rewrites() through untouched (no deco rewrites prepended)", async () => {
    const userRewrites = async () => [{ source: "/a", destination: "/b" }];
    const cfg = withDeco({ rewrites: userRewrites });
    expect(cfg.rewrites).toBe(userRewrites);
    expect(await cfg.rewrites!()).toEqual([{ source: "/a", destination: "/b" }]);
  });

  it("dedupes transpilePackages", () => {
    const cfg = withDeco({ transpilePackages: ["@decocms/blocks", "other"] });
    expect(cfg.transpilePackages!.filter((p: string) => p === "@decocms/blocks")).toHaveLength(1);
    expect(cfg.transpilePackages).toContain("other");
  });
});

describe("withDeco draft headers", () => {
  it("adds no-store/no-index rules for both draft signals", async () => {
    const headers = await withDeco({}).headers!();
    // Two rules, not one: `has` entries within a rule are ANDed, and the query
    // (entry) and cookie (navigation) signals never coincide.
    expect(headers).toHaveLength(2);
    expect(headers[0].has).toEqual([{ type: "query", key: "__draft" }]);
    expect(headers[1].has).toEqual([{ type: "cookie", key: "__deco_draft" }]);

    for (const rule of headers) {
      const byKey = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
      // `no-store` is what actually stops a shared cache serving unpublished
      // content to a real visitor — the pointer being a cookie means draft and
      // published share a URL.
      expect(byKey["Cache-Control"]).toBe("no-store, private");
      expect(byKey.Vary).toBe("Cookie");
      expect(byKey["X-Robots-Tag"]).toBe("noindex, nofollow");
    }
  });

  it("keeps a site's own headers, with the draft rules taking precedence", async () => {
    const cfg = withDeco({
      headers: async () => [
        { source: "/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=3600" }] },
      ],
    });
    const headers = await cfg.headers!();
    expect(headers).toHaveLength(3);
    // A site's catch-all cache policy must not out-rank the draft rules.
    expect(headers[0].has).toBeDefined();
    expect(headers[1].has).toBeDefined();
    expect(headers[2].headers[0].value).toBe("public, max-age=3600");
  });

  it("leaves a site without headers() untouched apart from the draft rules", async () => {
    expect(await withDeco({}).headers!()).toHaveLength(2);
  });
});
