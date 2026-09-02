/**
 * Regression tests for self-redirects — rules whose source and target resolve
 * to the same path, which a browser reports as ERR_TOO_MANY_REDIRECTS.
 *
 * The cases below are real rows from a bulk-migration CSV (Fresh -> TanStack)
 * that took two pages of a production storefront down.
 */
import { describe, expect, it } from "vitest";
import { addRedirects, loadRedirects, matchRedirect, parseRedirectsCsv } from "./redirects";

const fromCsv = (csv: string) => {
  const map = loadRedirects({});
  addRedirects(map, parseRedirectsCsv(csv));
  return map;
};

describe("self-redirects are dropped at load time", () => {
  it("drops a row that literally points at itself", () => {
    expect(parseRedirectsCsv("from,to\n/a,/a\n")).toEqual([]);
    expect(matchRedirect("/a", fromCsv("from,to\n/a,/a\n"))).toBeNull();
  });

  it("drops a row whose absolute source collapses onto its target", () => {
    // Took /aliancas down: normalizePath drops the query, leaving /x -> /x.
    const map = fromCsv(
      "from,to,type\nhttps://www.example.com/aliancas?map=category-1,/aliancas,PERMANENT\n",
    );
    expect(matchRedirect("/aliancas", map)).toBeNull();
  });

  it("drops a row whose absolute target collapses onto its source", () => {
    // Took the home page down: http://blog.example.com/ -> /
    expect(matchRedirect("/", fromCsv("from,to\nhttp://blog.example.com/,/\n"))).toBeNull();
  });

  it("drops a pair that differs only by trailing slash", () => {
    expect(parseRedirectsCsv("from,to\n/a/,/a\n")).toEqual([]);
    expect(parseRedirectsCsv("from,to\n/a,/a/\n")).toEqual([]);
  });

  it("drops a pair that differs only by case", () => {
    // normalizePath lowercases the source, so /A would match a request to /a.
    expect(parseRedirectsCsv("from,to\n/A,/a\n")).toEqual([]);
  });

  it("drops self-redirects declared as CMS blocks, not just CSV rows", () => {
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/loop", to: "/loop", type: "permanent" },
      },
    });
    expect(matchRedirect("/loop", map)).toBeNull();
  });

  it("keeps a same-path redirect that leaves the site", () => {
    // Same pathname, different host: a real redirect, not a loop.
    const map = fromCsv("from,to\n/x,https://other.example.com/x\n");
    expect(matchRedirect("/x", map)).toMatchObject({ to: "https://other.example.com/x" });
  });

  it("keeps a same-path redirect that only adds a query", () => {
    const map = fromCsv("from,to\n/x,/x?ref=1\n");
    expect(matchRedirect("/x", map)).toBeNull();
  });

  it("leaves ordinary redirects alone", () => {
    const map = fromCsv("from,to,type\n/old,/new,permanent\n/blog/*,/news/*,permanent\n");
    expect(matchRedirect("/old", map)).toMatchObject({ to: "/new", status: 301 });
    expect(matchRedirect("/blog/post-1", map)).toMatchObject({ to: "/news/post-1" });
    expect(matchRedirect("/unknown", map)).toBeNull();
  });
});
