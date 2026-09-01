/**
 * Rules whose source carries a query string.
 *
 * The Fresh loader this SDK replaced matched the whole href, so a rule written
 * against `/x?map=category-1` fired for that query only. Here the map is keyed
 * by pathname, so the query travels beside it and is checked at match time.
 */
import { describe, expect, it } from "vitest";
import { addRedirects, loadRedirects, matchRedirect, parseRedirectsCsv } from "./redirects";

const fromCsv = (csv: string) => {
  const map = loadRedirects({});
  addRedirects(map, parseRedirectsCsv(csv));
  return map;
};

describe("query-scoped rules", () => {
  it("fires for the query it was written against", () => {
    const map = fromCsv("from,to,type\n/relogios?map=category-1,/relogios/todos,permanent\n");

    expect(matchRedirect("/relogios", map, "map=category-1")).toMatchObject({
      to: "/relogios/todos",
      status: 301,
    });
    expect(matchRedirect("/relogios", map, "?map=category-1")).toMatchObject({
      to: "/relogios/todos",
    });
  });

  it("stays out of the way of the bare path", () => {
    const map = fromCsv("from,to\n/relogios?map=category-1,/relogios/todos\n");

    expect(matchRedirect("/relogios", map)).toBeNull();
    expect(matchRedirect("/relogios", map, "")).toBeNull();
    expect(matchRedirect("/relogios", map, "map=something-else")).toBeNull();
  });

  it("survives a source that points at its own bare path", () => {
    // The row that caused the loop: legitimate once the query is honored.
    const map = fromCsv(
      "from,to,type\nhttps://www.example.com/aliancas?map=category-1,/aliancas,PERMANENT\n",
    );

    expect(matchRedirect("/aliancas", map)).toBeNull();
    expect(matchRedirect("/aliancas", map, "map=category-1")).toMatchObject({ to: "/aliancas" });
  });

  it("tolerates tracking params appended to the request", () => {
    const map = fromCsv("from,to\n/p?map=c,/new\n");

    expect(matchRedirect("/p", map, "map=c&utm_source=news&gclid=x")).toMatchObject({ to: "/new" });
    expect(matchRedirect("/p", map, "utm_source=news")).toBeNull();
  });

  it("requires every param of a multi-param rule", () => {
    const map = fromCsv("from,to\n/p?a=1&b=2,/new\n");

    expect(matchRedirect("/p", map, "a=1&b=2")).toMatchObject({ to: "/new" });
    expect(matchRedirect("/p", map, "a=1")).toBeNull();
    expect(matchRedirect("/p", map, "a=1&b=3")).toBeNull();
  });

  it("wins over the bare-path rule for the same pathname", () => {
    const map = fromCsv("from,to\n/x,/bare\n/x?v=1,/scoped\n");

    expect(matchRedirect("/x", map)).toMatchObject({ to: "/bare" });
    expect(matchRedirect("/x", map, "v=1")).toMatchObject({ to: "/scoped" });
    expect(matchRedirect("/x", map, "v=2")).toMatchObject({ to: "/bare" });
  });

  it("keeps several rules on one pathname apart", () => {
    const map = fromCsv("from,to\n/x?v=1,/one\n/x?v=2,/two\n");

    expect(matchRedirect("/x", map, "v=1")).toMatchObject({ to: "/one" });
    expect(matchRedirect("/x", map, "v=2")).toMatchObject({ to: "/two" });
    expect(matchRedirect("/x", map, "v=3")).toBeNull();
  });

  it("works for CMS blocks, not just CSV rows", () => {
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/x?legacy=1", to: "/y", type: "permanent" },
      },
    });

    expect(matchRedirect("/x", map)).toBeNull();
    expect(matchRedirect("/x", map, "legacy=1")).toMatchObject({ to: "/y", status: 301 });
  });

  it("leaves rules without a query untouched", () => {
    const map = fromCsv("from,to,type\n/old,/new,permanent\n/blog/*,/news/*,permanent\n");

    expect(matchRedirect("/old", map)).toMatchObject({ to: "/new", status: 301 });
    expect(matchRedirect("/old", map, "utm_source=x")).toMatchObject({ to: "/new" });
    expect(matchRedirect("/blog/post-1", map, "a=1")).toMatchObject({ to: "/news/post-1" });
  });
});
