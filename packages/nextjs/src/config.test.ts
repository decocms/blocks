import { describe, expect, it } from "vitest";
import { DECO_REWRITES, withDeco } from "./config.cjs";

// withDeco()'s declared return type is the standard (loosely typed) Next.js
// NextConfig, whose `rewrites`/`transpilePackages` are optional and
// union-typed. The runtime object always has them (withDeco always sets
// them), so tests assert that with `!` / casts rather than loosening the
// public declaration.
describe("withDeco", () => {
  it("adds rewrites and transpilePackages to a bare config", async () => {
    const cfg = withDeco({});
    expect(cfg.transpilePackages).toEqual(
      expect.arrayContaining(["@decocms/blocks", "@decocms/blocks-admin", "@decocms/nextjs"]),
    );
    expect(await cfg.rewrites!()).toEqual(DECO_REWRITES);
  });

  it("prepends deco rewrites to a user's array-returning rewrites()", async () => {
    const cfg = withDeco({
      rewrites: async () => [{ source: "/a", destination: "/b" }],
    });
    const out = (await cfg.rewrites!()) as Array<{ source: string; destination: string }>;
    expect(out.slice(0, DECO_REWRITES.length)).toEqual(DECO_REWRITES);
    expect(out.at(-1)).toEqual({ source: "/a", destination: "/b" });
  });

  it("merges into a user's object-form rewrites via beforeFiles", async () => {
    const cfg = withDeco({
      rewrites: async () => ({
        beforeFiles: [{ source: "/x", destination: "/y" }],
        afterFiles: [],
        fallback: [],
      }),
    });
    const out = (await cfg.rewrites!()) as {
      beforeFiles: Array<{ source: string; destination: string }>;
    };
    expect(out.beforeFiles.slice(0, DECO_REWRITES.length)).toEqual(DECO_REWRITES);
    expect(out.beforeFiles.at(-1)).toEqual({ source: "/x", destination: "/y" });
  });

  it("dedupes transpilePackages", () => {
    const cfg = withDeco({ transpilePackages: ["@decocms/blocks", "other"] });
    expect(cfg.transpilePackages!.filter((p: string) => p === "@decocms/blocks")).toHaveLength(1);
    expect(cfg.transpilePackages).toContain("other");
  });
});
