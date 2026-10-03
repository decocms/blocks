// @vitest-environment node
/** matchRoute (routing.mdx, router-internals.mdx, api-reference#matchroute-url-items; D3 splat). */
import { describe, expect, it } from "vitest";
import { matchRoute } from "./matchRoute";
import type { LegacyRedirect, Redirect, Route } from "./types";

const route = (name: string, path: string) => ({ name, path, __resolveType: "page" });

const summer = route("SummerPage", "/summer");
const shirt = route("ShirtPage", "/:slug/p");
const archive = route("BlogArchive", "/blog/archive");
const post = route("Post", "/blog/:slug");
const home = route("Home", "/");
const routes = [summer, shirt, archive, post, home];

const legacySummer: Redirect = { from: "/campaigns/summer", to: "/summer", permanent: true };
const legacyProduct: Redirect = { from: "/old-products/:slug", to: "/:slug/p", permanent: true };

describe("routes", () => {
  it("matches an exact path", () => {
    expect(matchRoute("/summer", { routes })).toEqual({ kind: "match", entry: summer, params: {} });
  });

  it("matches a template and returns its params (/:slug/p)", () => {
    expect(matchRoute("/summer/p", { routes })).toEqual({
      kind: "match",
      entry: shirt,
      params: { slug: "summer" },
    });
  });

  it("returns the stored entry you passed in", () => {
    const hit = matchRoute("/summer", { routes });
    expect(hit.kind === "match" && hit.entry).toBe(summer);
  });

  it("matches the root", () => {
    expect(matchRoute("/", { routes })).toEqual({ kind: "match", entry: home, params: {} });
  });

  it("exact paths win over templates, per segment (the router-internals trie)", () => {
    expect(matchRoute("/blog/archive", { routes })).toMatchObject({ entry: archive });
    expect(matchRoute("/blog/hello-world", { routes })).toMatchObject({
      entry: post,
      params: { slug: "hello-world" },
    });
  });

  it("backtracks to the parameter child when a literal branch dead-ends", () => {
    const deep = route("Deep", "/blog/archive/2026");
    const tagged = route("Tagged", "/blog/:slug/comments");
    const hit = matchRoute("/blog/archive/comments", { routes: [deep, tagged] });
    expect(hit).toEqual({ kind: "match", entry: tagged, params: { slug: "archive" } });
  });

  it("is not-found when nothing matches", () => {
    expect(matchRoute("/nope/at/all", { routes })).toEqual({ kind: "not-found" });
    expect(matchRoute("/summer", { routes: [] })).toEqual({ kind: "not-found" });
  });

  it("accepts a string, a full URL string, a URL or a Request", () => {
    const expected = { kind: "match", entry: summer, params: {} };
    expect(matchRoute("https://store.example.com/summer?x=1", { routes })).toEqual(expected);
    expect(matchRoute(new URL("https://store.example.com/summer"), { routes })).toEqual(expected);
    expect(matchRoute(new Request("https://store.example.com/summer"), { routes })).toEqual(
      expected,
    );
  });

  it("normalizes the URL: trailing slash, query, fragment, empty segments", () => {
    for (const url of ["/summer/", "/summer?utm=1", "/summer#top", "//summer", "/summer//"]) {
      expect(matchRoute(url, { routes }), url).toMatchObject({ kind: "match", entry: summer });
    }
  });

  it("percent-decodes the URL; params are decoded and never contain a slash", () => {
    expect(matchRoute("/caf%C3%A9/p", { routes })).toMatchObject({ params: { slug: "café" } });
    // An encoded slash doesn't make a one-segment parameter span two segments.
    expect(matchRoute("/a%2Fb/p", { routes })).toEqual({ kind: "not-found" });
    expect(matchRoute("/a/b/p", { routes })).toEqual({ kind: "not-found" });
  });

  it("matches a literal template segment written encoded or not", () => {
    const cafe = route("Cafe", "/caf%C3%A9");
    expect(matchRoute("/café", { routes: [cafe] })).toMatchObject({ entry: cafe });
  });

  it("is case-sensitive by default, with ignoreCase as an option", () => {
    expect(matchRoute("/SUMMER", { routes })).toEqual({ kind: "not-found" });
    expect(matchRoute("/SUMMER", { routes }, { ignoreCase: true })).toMatchObject({
      entry: summer,
    });
    expect(matchRoute("/Blog/Hello", { routes }, { ignoreCase: true })).toMatchObject({
      entry: post,
      params: { slug: "Hello" },
    });
  });

  it("skips entries without a string path (never throws)", () => {
    const odd = [{ name: "x" }, null, { name: "y", path: 5 }, summer] as unknown as Route[];
    expect(matchRoute("/summer", { routes: odd })).toMatchObject({ entry: summer });
  });

  it("never throws on a malformed URL or items", () => {
    expect(matchRoute("http://[::1", { routes })).toEqual({ kind: "not-found" });
    expect(matchRoute("/x", { routes: undefined as never })).toEqual({ kind: "not-found" });
    expect(matchRoute("/x", undefined as never)).toEqual({ kind: "not-found" });
    expect(matchRoute("/caf%E0%A4%A/p", { routes })).toMatchObject({ kind: "match" });
  });

  it("works for your own routable types (posts)", () => {
    const hello = {
      __resolveType: "post",
      name: "Hello, world",
      path: "/blog/hello-world",
      date: "2026-09-01",
    };
    expect(matchRoute("/blog/hello-world", { routes: [...routes, hello] })).toMatchObject({
      entry: hello,
    });
  });
});

describe("match order and conflicts", () => {
  it("two entries with the same path: the earlier one wins", () => {
    const a = route("A", "/same");
    const b = route("B", "/same");
    expect(matchRoute("/same", { routes: [a, b] })).toMatchObject({ entry: a });
    expect(matchRoute("/same", { routes: [b, a] })).toMatchObject({ entry: b });
  });

  it("two templates of the same shape: the earlier one wins, with its own param names", () => {
    const bySlug = route("BySlug", "/:slug/p");
    const byId = route("ById", "/:id/p");
    expect(matchRoute("/x/p", { routes: [bySlug, byId] })).toEqual({
      kind: "match",
      entry: bySlug,
      params: { slug: "x" },
    });
    expect(matchRoute("/x/p", { routes: [byId, bySlug] })).toEqual({
      kind: "match",
      entry: byId,
      params: { id: "x" },
    });
  });

  it("caches the compiled trie per routes array: the same array skips the build", () => {
    const list = [route("A", "/a")];
    expect(matchRoute("/a", { routes: list })).toMatchObject({ kind: "match" });
    // Mutating the cached array isn't seen: pass a new array per revision.
    list.push(route("B", "/b"));
    expect(matchRoute("/b", { routes: list })).toEqual({ kind: "not-found" });
    expect(matchRoute("/b", { routes: [...list] })).toMatchObject({ kind: "match" });
  });

  it("handles many routes (a lookup costs the URL's depth)", () => {
    const many = Array.from({ length: 50_000 }, (_, i) => route(`P${i}`, `/products/item-${i}`));
    const started = performance.now();
    expect(matchRoute("/products/item-49999", { routes: many })).toMatchObject({
      entry: many[49_999],
    });
    for (let i = 0; i < 1000; i++) matchRoute(`/products/item-${i}`, { routes: many });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("splat (D3)", () => {
  const catchAll = route("PLP", "/*");
  const blogRest = route("BlogRest", "/blog/:rest*");

  it("a trailing /* matches any number of remaining segments", () => {
    expect(matchRoute("/shoes/running/men", { routes: [catchAll] })).toEqual({
      kind: "match",
      entry: catchAll,
      params: { "*": "shoes/running/men" },
    });
  });

  it("a trailing /:rest* names the remainder", () => {
    expect(matchRoute("/blog/2026/10/hello", { routes: [blogRest] })).toEqual({
      kind: "match",
      entry: blogRest,
      params: { rest: "2026/10/hello" },
    });
  });

  it("also matches nothing, so /* serves / and /blog/:rest* serves /blog", () => {
    expect(matchRoute("/", { routes: [catchAll] })).toMatchObject({ params: { "*": "" } });
    expect(matchRoute("/blog", { routes: [blogRest] })).toMatchObject({ params: { rest: "" } });
  });

  it("has the lowest precedence: literal, then param, then splat", () => {
    const all = [catchAll, post, archive, home, blogRest];
    expect(matchRoute("/", { routes: all })).toMatchObject({ entry: home });
    expect(matchRoute("/blog/archive", { routes: all })).toMatchObject({ entry: archive });
    expect(matchRoute("/blog/hello", { routes: all })).toMatchObject({ entry: post });
    expect(matchRoute("/blog/a/b", { routes: all })).toMatchObject({ entry: blogRest });
    expect(matchRoute("/shoes/a", { routes: all })).toMatchObject({ entry: catchAll });
  });

  it("keeps params captured before the splat", () => {
    const r = route("Cat", "/:dept/*");
    expect(matchRoute("/shoes/running/men", { routes: [r] })).toMatchObject({
      params: { dept: "shoes", "*": "running/men" },
    });
  });

  it("a splat that isn't the last segment is ignored", () => {
    const r = route("Bad", "/a/*/b");
    expect(matchRoute("/a/x/b", { routes: [r] })).toEqual({ kind: "not-found" });
  });

  it("the earlier splat wins a conflict", () => {
    const a = route("A", "/*");
    const b = route("B", "/:all*");
    expect(matchRoute("/x/y", { routes: [a, b] })).toMatchObject({
      entry: a,
      params: { "*": "x/y" },
    });
  });
});

describe("redirects", () => {
  it("returns the redirect with location and status 301 from permanent", () => {
    expect(matchRoute("/campaigns/summer", { routes, redirects: [legacySummer] })).toEqual({
      kind: "redirect",
      location: "/summer",
      status: 301,
    });
  });

  it("permanent: false is a 302", () => {
    expect(
      matchRoute("/a", { routes, redirects: [{ from: "/a", to: "/b", permanent: false }] }),
    ).toMatchObject({ status: 302 });
  });

  it("status wins over permanent: 301, 302, 307 and 308", () => {
    for (const status of [301, 302, 307, 308] as const) {
      expect(
        matchRoute("/a", {
          routes,
          redirects: [{ from: "/a", to: "/b", permanent: true, status }],
        }),
      ).toMatchObject({ status });
    }
  });

  it("an invalid status falls back to permanent", () => {
    expect(
      matchRoute("/a", {
        routes,
        redirects: [{ from: "/a", to: "/b", permanent: true, status: 303 as never }],
      }),
    ).toMatchObject({ status: 301 });
  });

  it("fills parameters into to (/old-products/summer → /summer/p)", () => {
    expect(matchRoute("/old-products/summer", { routes, redirects: [legacyProduct] })).toEqual({
      kind: "redirect",
      location: "/summer/p",
      status: 301,
    });
  });

  it("carries the request's query string over", () => {
    expect(
      matchRoute("/campaigns/summer?utm_source=email&x=1", { routes, redirects: [legacySummer] }),
    ).toMatchObject({ location: "/summer?utm_source=email&x=1" });
  });

  it("merges the query with one already in to", () => {
    expect(
      matchRoute("/a?x=1", {
        routes,
        redirects: [{ from: "/a", to: "/b?ref=old#top", permanent: true }],
      }),
    ).toMatchObject({ location: "/b?ref=old&x=1#top" });
  });

  it("discardQueryParameters drops it", () => {
    expect(
      matchRoute("/a?x=1", {
        routes,
        redirects: [{ from: "/a", to: "/b", permanent: true, discardQueryParameters: true }],
      }),
    ).toMatchObject({ location: "/b" });
  });

  it("keeps an absolute to", () => {
    expect(
      matchRoute("/out/shoes", {
        routes,
        redirects: [{ from: "/out/:slug", to: "https://other.example/:slug", permanent: false }],
      }),
    ).toMatchObject({ location: "https://other.example/shoes", status: 302 });
  });

  it("encodes filled parameters", () => {
    expect(
      matchRoute("/old-products/caf%C3%A9", { routes, redirects: [legacyProduct] }),
    ).toMatchObject({
      location: "/caf%C3%A9/p",
    });
  });

  it("redirects are checked before routes: a redirect overrides a route at the same path", () => {
    expect(
      matchRoute("/summer", {
        routes,
        redirects: [{ from: "/summer", to: "/winter", permanent: false }],
      }),
    ).toMatchObject({ kind: "redirect", location: "/winter" });
  });

  it("exact redirects win over template redirects; the earlier wins a conflict", () => {
    const redirects: Redirect[] = [
      { from: "/old/:slug", to: "/template/:slug", permanent: true },
      { from: "/old/special", to: "/special", permanent: true },
      { from: "/old/:other", to: "/never", permanent: true },
    ];
    expect(matchRoute("/old/special", { routes, redirects })).toMatchObject({
      location: "/special",
    });
    expect(matchRoute("/old/x", { routes, redirects })).toMatchObject({ location: "/template/x" });
  });

  it("a splat redirect substitutes the remainder (D3)", () => {
    const redirects: Redirect[] = [
      { from: "/old/*", to: "/new/*", permanent: true },
      { from: "/docs/:rest*", to: "/next/:rest*", permanent: false, status: 308 },
    ];
    expect(matchRoute("/old/a/b", { routes, redirects })).toMatchObject({ location: "/new/a/b" });
    expect(matchRoute("/docs/x/y?q=1", { routes, redirects })).toMatchObject({
      location: "/next/x/y?q=1",
      status: 308,
    });
  });

  describe("never redirects off-site through a splat", () => {
    const redirects: Redirect[] = [
      { from: "/old/*", to: "/*", permanent: true },
      { from: "/docs/:rest*", to: "/:rest*", permanent: true },
    ];
    const cases: [string, string][] = [
      ["/old/%2Fevil.com", "/%2Fevil.com"],
      ["/old/%2F%2Fevil.com", "/%2F%2Fevil.com"],
      ["/old/%5Cevil.com", "/%5Cevil.com"],
      ["/old/%2Fevil.com/x", "/%2Fevil.com/x"],
      ["/docs/%2F%2Fevil.com", "/%2F%2Fevil.com"],
      ["https://shop.example/old/%2Fevil.com", "/%2Fevil.com"],
      ["/old/\\evil.com", "/%5Cevil.com"],
    ];
    for (const [url, location] of cases) {
      it(`${url} → ${location}`, () => {
        const hit = matchRoute(url, { routes, redirects });
        expect(hit).toMatchObject({ kind: "redirect", location });
        const resolved = new URL((hit as { location: string }).location, "https://shop.example/");
        expect(resolved.origin).toBe("https://shop.example");
      });
    }

    it("keeps an encoded slash encoded in a splat, and a route splat's params decoded", () => {
      expect(matchRoute("/old/a%2Fb/c", { routes, redirects: [redirects[0]!] })).toMatchObject({
        location: "/a%2Fb/c",
      });
      expect(matchRoute("/x/a%2Fb", { routes: [route("All", "/x/*")] })).toMatchObject({
        params: { "*": "a/b" },
      });
    });

    it("leaves an absolute or protocol-relative `to` alone", () => {
      const external: Redirect[] = [
        { from: "/ext/*", to: "https://other.example/*", permanent: false },
      ];
      expect(matchRoute("/ext/a/b", { routes, redirects: external })).toMatchObject({
        location: "https://other.example/a/b",
      });
    });
  });

  it("falls through to routes when no redirect matches", () => {
    expect(matchRoute("/summer", { routes, redirects: [legacySummer] })).toMatchObject({
      kind: "match",
    });
  });

  it("accepts v7's nested shape: permanent is a 301, temporary a 307", () => {
    const legacy: LegacyRedirect[] = [
      { redirect: { from: "/p", to: "/perm", type: "permanent" } },
      { redirect: { from: "/t", to: "/temp", type: "temporary" } },
      { redirect: { from: "/d", to: "/drop", type: "temporary", discardQueryParameters: true } },
    ];
    expect(matchRoute("/p", { routes, redirects: legacy })).toEqual({
      kind: "redirect",
      location: "/perm",
      status: 301,
    });
    expect(matchRoute("/t?x=1", { routes, redirects: legacy })).toEqual({
      kind: "redirect",
      location: "/temp?x=1",
      status: 307,
    });
    expect(matchRoute("/d?x=1", { routes, redirects: legacy })).toMatchObject({
      location: "/drop",
    });
  });

  it("mixes both shapes in one list", () => {
    const mixed = [legacySummer, { redirect: { from: "/old", to: "/new" } }] as (
      | Redirect
      | LegacyRedirect
    )[];
    expect(matchRoute("/old", { routes, redirects: mixed })).toMatchObject({
      location: "/new",
      status: 307,
    });
    expect(matchRoute("/campaigns/summer", { routes, redirects: mixed })).toMatchObject({
      status: 301,
    });
  });

  it("skips malformed redirects", () => {
    const junk = [
      null,
      {},
      { from: 1, to: "/x" },
      { redirect: null },
      { redirect: { from: "/a" } },
      legacySummer,
    ];
    expect(matchRoute("/campaigns/summer", { routes, redirects: junk as never })).toMatchObject({
      kind: "redirect",
    });
  });

  it("ignoreCase applies to redirects too", () => {
    expect(
      matchRoute("/Campaigns/SUMMER", { routes, redirects: [legacySummer] }, { ignoreCase: true }),
    ).toMatchObject({ kind: "redirect", location: "/summer" });
  });

  it("the routing.mdx handler: list, match, resolve", () => {
    const pages = [summer, shirt];
    const posts = [{ __resolveType: "post", name: "Hello", path: "/blog/hello-world" }];
    const redirects = [legacySummer];
    const match = matchRoute(new Request("https://s.example/blog/hello-world"), {
      routes: [...pages, ...posts],
      redirects,
    });
    expect(match.kind === "match" && match.entry.__resolveType).toBe("post");
  });
});
