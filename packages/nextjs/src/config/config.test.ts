// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DRAFT_COOKIE, DRAFT_PARAM, draftResponseHeaders } from "../draft.ts";
import { isStudioOrigin, STUDIO_ORIGINS } from "../studio.ts";
import type * as Config from "./index.cjs";

const require = createRequire(import.meta.url);
const { withDeco, DECO_DRAFT_HEADERS, STUDIO_DEV_ORIGINS } =
  require("./index.cjs") as typeof Config;

describe("the names withDeco repeats are the package's (src/draft.ts, src/studio.ts)", () => {
  it("draft query and cookie, and the draft response headers", () => {
    expect(DECO_DRAFT_HEADERS.map((r) => r.has?.[0])).toEqual([
      { type: "query", key: DRAFT_PARAM },
      { type: "cookie", key: DRAFT_COOKIE },
    ]);
    for (const rule of DECO_DRAFT_HEADERS) {
      expect(Object.fromEntries(rule.headers.map((h) => [h.key, h.value]))).toEqual(
        draftResponseHeaders("a.example.com/x@v1"),
      );
    }
  });

  it("Studio's origins, as allowedDevOrigins hosts", () => {
    const fromPackage = STUDIO_ORIGINS.map((o) => new URL(o.replace("*.", "wildcard.")).host).map(
      (h) => h.replace(/^wildcard\./, "**."),
    );
    expect(STUDIO_DEV_ORIGINS).toEqual(fromPackage);
    for (const host of ["studio.decocms.com", "a.b.decocms.com", "decocms.com"]) {
      expect(isStudioOrigin(`https://${host}`)).toBe(true);
    }
  });
});

describe("withDeco", () => {
  it("puts the draft rules before the site's own and merges allowedDevOrigins", async () => {
    const site = {
      source: "/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=60" }],
    };
    const config = withDeco({
      poweredByHeader: false,
      allowedDevOrigins: ["**.style.dev", "decocms.com"],
      headers: async () => [site],
    });
    expect(config.poweredByHeader).toBe(false);
    expect(await config.headers!()).toEqual([...DECO_DRAFT_HEADERS, site]);
    expect(config.allowedDevOrigins).toEqual([
      "**.style.dev",
      "decocms.com",
      ...STUDIO_DEV_ORIGINS.filter((o) => o !== "decocms.com"),
    ]);
  });

  it("works with nothing to merge, and each part can be turned off", async () => {
    expect(await withDeco({}).headers!()).toEqual(DECO_DRAFT_HEADERS);
    const off = withDeco({}, { draftHeaders: false, studioOrigins: false });
    expect(off.headers).toBeUndefined();
    expect(off.allowedDevOrigins).toBeUndefined();
  });

  it("adds no rewrites and no image rules", () => {
    const config = withDeco({});
    expect(Object.keys(config).sort()).toEqual(["allowedDevOrigins", "headers"]);
  });
});
