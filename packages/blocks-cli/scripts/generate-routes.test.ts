import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRoutes, patternToRegex, renderRoutesModule } from "./generate-routes";

/** Applies a compiled pattern the way the device runtime does. */
const run = (urlPattern: string, pathname: string) => {
  const compiled = patternToRegex(urlPattern);
  if (!compiled) return null;
  const found = new RegExp(compiled.pattern).exec(pathname);
  if (!found) return null;
  return Object.fromEntries(compiled.params.map((name, i) => [name, found[i + 1]]));
};

describe("patternToRegex", () => {
  it("compiles a static path", () => {
    expect(run("/men", "/men")).toEqual({});
    expect(run("/men", "/women")).toBeNull();
    expect(run("/men", "/men/shirts")).toBeNull();
  });

  it("compiles the root without swallowing every path", () => {
    // `^/?$` — the bug to avoid is `/` matching `/anything`.
    expect(run("/", "/")).toEqual({});
    expect(run("/", "/men")).toBeNull();
  });

  it("captures a named param", () => {
    expect(run("/products/:slug", "/products/dad-hat-4438")).toEqual({ slug: "dad-hat-4438" });
    // A param is one segment, never two.
    expect(run("/products/:slug", "/products/a/b")).toBeNull();
  });

  it("captures multiple params in order", () => {
    const compiled = patternToRegex("/:lang/products/:slug");
    expect(compiled?.params).toEqual(["lang", "slug"]);
    expect(run("/:lang/products/:slug", "/pt/products/tee")).toEqual({ lang: "pt", slug: "tee" });
  });

  it("makes the catch-all match nested paths", () => {
    // `/*` is the Category Page on a real storefront — it is why that site
    // never 404s.
    expect(run("/*", "/anything/deep/here")).toEqual({ _: "anything/deep/here" });
  });

  it("tolerates a trailing slash", () => {
    expect(run("/products/:slug", "/products/tee/")).toEqual({ slug: "tee" });
  });

  it("escapes regex metacharacters in literal segments", () => {
    // A page path like `/promo.2026` must not let `.` match any character.
    expect(run("/promo.2026", "/promo.2026")).toEqual({});
    expect(run("/promo.2026", "/promoX2026")).toBeNull();
  });

  it("refuses optional groups instead of compiling them wrong", () => {
    // `/black-friday{/70-off}?` is valid URLPattern with no Expo equivalent.
    // Returning null routes the page to the WebView, which is correct.
    expect(patternToRegex("/black-friday{/70-off}?")).toBeNull();
  });

  it("refuses a mixed segment rather than guessing", () => {
    expect(patternToRegex("/products/pre-:slug")).toBeNull();
  });

  it("refuses a param name that is not an identifier", () => {
    expect(patternToRegex("/products/:1bad")).toBeNull();
  });
});

describe("collectRoutes", () => {
  const dirs: string[] = [];
  const makeBlocks = (blocks: Record<string, unknown>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deco-routes-"));
    dirs.push(dir);
    for (const [name, block] of Object.entries(blocks)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(block));
    }
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads only page blocks that declare a path", () => {
    const dir = makeBlocks({
      "pages-home.json": { name: "Home", path: "/", sections: [] },
      "pages-draft.json": { name: "No path", sections: [] },
      "Header.json": { __resolveType: "site/sections/Header.tsx" },
    });
    expect(collectRoutes(dir).map((r) => r.path)).toEqual(["/"]);
  });

  it("sorts by specificity so the catch-all is tried last", () => {
    // Without this, `/*` would swallow `/products/:slug` and every landing page.
    const dir = makeBlocks({
      "pages-cat.json": { name: "Category", path: "/*" },
      "pages-home.json": { name: "Home", path: "/" },
      "pages-pdp.json": { name: "PDP", path: "/products/:slug" },
      "pages-men.json": { name: "Men", path: "/men" },
    });
    expect(collectRoutes(dir).map((r) => r.path)).toEqual(["/men", "/products/:slug", "/", "/*"]);
  });

  it("de-dupes pages sharing one path", () => {
    // A/B variants of the same page are separate blocks with the same path.
    const dir = makeBlocks({
      "pages-home-a.json": { name: "Home A", path: "/" },
      "pages-home-b.json": { name: "Home B", path: "/" },
    });
    expect(collectRoutes(dir)).toHaveLength(1);
  });

  it("warns about a page it cannot compile instead of dropping it silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = makeBlocks({ "pages-bf.json": { name: "BF", path: "/black-friday{/70-off}?" } });
    expect(collectRoutes(dir)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falls back to WebView"));
    warn.mockRestore();
  });

  it("handles URL-encoded block filenames", () => {
    const dir = makeBlocks({ "pages-Landing%20Page.json": { name: "LP", path: "/lp" } });
    expect(collectRoutes(dir).map((r) => r.path)).toEqual(["/lp"]);
  });

  it("skips a malformed block rather than failing the whole build", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deco-routes-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "pages-broken.json"), "{not json");
    fs.writeFileSync(path.join(dir, "pages-ok.json"), JSON.stringify({ name: "Ok", path: "/ok" }));
    expect(collectRoutes(dir).map((r) => r.path)).toEqual(["/ok"]);
  });

  it("returns nothing when the blocks directory is absent", () => {
    expect(collectRoutes("/definitely/not/here")).toEqual([]);
  });
});

describe("renderRoutesModule", () => {
  const routes = collectRoutesFrom([
    { name: "Product Page", path: "/products/:slug" },
    { name: "Home Page", path: "/" },
  ]);

  function collectRoutesFrom(pages: Array<{ name: string; path: string }>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deco-routes-render-"));
    pages.forEach((p, i) => fs.writeFileSync(path.join(dir, `pages-${i}.json`), JSON.stringify(p)));
    const result = collectRoutes(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }

  it("emits a module that parses and carries the table", () => {
    const source = renderRoutesModule(routes);
    expect(source).toContain("export const cmsRoutes: CmsRoute[]");
    expect(source).toContain('path: "/products/:slug"');
    expect(source).toContain('pattern: "^/products/([^/]+)/?$"');
  });

  it("suggests the Expo route shape for each page", () => {
    // The generated file is where someone learns how to opt a page in.
    expect(renderRoutesModule(routes)).toContain('"/products/:slug": "/products/[slug]"');
  });

  it("says out loud that it is a snapshot, not a whitelist", () => {
    // If someone treats it as a whitelist, a page published after the build
    // stops opening in the app until the next store release.
    expect(renderRoutesModule(routes)).toContain("SNAPSHOT, not a whitelist");
  });

  it("is deterministic, so the incremental digest stays stable", () => {
    expect(renderRoutesModule(routes)).toBe(renderRoutesModule(routes));
  });
});
