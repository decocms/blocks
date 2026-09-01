import { describe, expect, it } from "vitest";
import { type CmsRoute, createRoutePolicy, matchCmsRoute } from "./routes";

/**
 * The real table `generate-routes` emits for `deco-sites/storefront-tanstack`,
 * in the order it emits it (specificity-sorted). Using the real shape matters:
 * the catch-all `/*` is what makes ordering load-bearing, and it is what makes
 * a 404 impossible on that site.
 */
const ROUTES: CmsRoute[] = [
  { path: "/accessories", name: "LP Accessories", params: [], pattern: "^/accessories/?$" },
  { path: "/men", name: "LP Men", params: [], pattern: "^/men/?$" },
  { path: "/s", name: "Search", params: [], pattern: "^/s/?$" },
  {
    path: "/products/:slug",
    name: "Product Page",
    params: ["slug"],
    pattern: "^/products/([^/]+)/?$",
  },
  { path: "/", name: "Home Page", params: [], pattern: "^/?$" },
  { path: "/*", name: "Category Page", params: ["_"], pattern: "^/(.*)/?$" },
];

describe("matchCmsRoute", () => {
  it("matches a static page", () => {
    expect(matchCmsRoute(ROUTES, "/men")?.route.name).toBe("LP Men");
  });

  it("extracts params from a dynamic page", () => {
    const match = matchCmsRoute(ROUTES, "/products/dad-hat-4438");
    expect(match?.route.path).toBe("/products/:slug");
    expect(match?.params).toEqual({ slug: "dad-hat-4438" });
  });

  it("prefers the specific route over the catch-all", () => {
    // Ordering is the whole reason the generator sorts by specificity.
    expect(matchCmsRoute(ROUTES, "/accessories")?.route.name).toBe("LP Accessories");
    expect(matchCmsRoute(ROUTES, "/whatever")?.route.name).toBe("Category Page");
  });

  it("matches the home page without swallowing everything", () => {
    expect(matchCmsRoute(ROUTES, "/")?.route.name).toBe("Home Page");
  });

  it("ignores query and hash", () => {
    expect(matchCmsRoute(ROUTES, "/products/tee-1?skuId=9")?.params).toEqual({ slug: "tee-1" });
    expect(matchCmsRoute(ROUTES, "/men#top")?.route.name).toBe("LP Men");
  });

  it("tolerates a trailing slash", () => {
    expect(matchCmsRoute(ROUTES, "/products/tee-1/")?.params).toEqual({ slug: "tee-1" });
  });

  it("decodes params", () => {
    expect(matchCmsRoute(ROUTES, "/products/cal%C3%A7a")?.params).toEqual({ slug: "calça" });
  });

  it("returns null when no route matches", () => {
    // Only possible on a site with no catch-all page.
    expect(matchCmsRoute([ROUTES[0]], "/nope")).toBeNull();
  });
});

describe("createRoutePolicy", () => {
  const policy = createRoutePolicy({
    routes: ROUTES,
    native: { "/": "/(tabs)/home", "/products/:slug": "/product/[slug]" },
  });

  it("sends an opted-in page to its native screen, with params filled", () => {
    const target = policy.resolve("/products/dad-hat-4438");
    expect(target).toMatchObject({ kind: "native", route: "/product/dad-hat-4438" });
  });

  it("sends a page that matched but is not opted in to the WebView", () => {
    // /men is a real CMS page with no native screen — the common case, and the
    // reason opting in is per-route.
    expect(policy.resolve("/men")).toMatchObject({ kind: "web" });
  });

  it("sends an unknown path to the WebView, never a 404", () => {
    // A page published in Studio after this binary was built is not in the
    // generated table. It must still open.
    const target = policy.resolve("/promo-lancada-hoje");
    expect(target.kind).toBe("web");
    expect(target.route).toContain("promo-lancada-hoje");
  });

  it("accepts the absolute URL the CMS puts in content", () => {
    // `product.url` comes back as https://<host>/products/<slug>.
    expect(policy.resolve("https://loja.example.com/products/tee-1")).toMatchObject({
      kind: "native",
      route: "/product/tee-1",
    });
  });

  it("keeps the query when falling back to the WebView", () => {
    expect(policy.resolve("/s?q=hat").route).toContain(encodeURIComponent("s?q=hat"));
  });

  it("encodes a path into a single WebView segment", () => {
    // Otherwise a nested path would break the catch-all route.
    expect(policy.resolve("/institucional/trocas").route).toBe("/web/institucional%2Ftrocas");
  });

  it("honors a custom webRoute builder", () => {
    const custom = createRoutePolicy({
      routes: ROUTES,
      native: {},
      webRoute: (p) => `/browser?url=${encodeURIComponent(p)}`,
    });
    expect(custom.resolve("/men").route).toBe("/browser?url=%2Fmen");
  });

  it("substitutes a `:slug`-style target as well as `[slug]`", () => {
    const colon = createRoutePolicy({
      routes: ROUTES,
      native: { "/products/:slug": "/product/:slug" },
    });
    expect(colon.resolve("/products/tee-1").route).toBe("/product/tee-1");
  });

  it("falls back to the WebView on an unparseable absolute URL", () => {
    expect(policy.resolve("http://[bad").kind).toBe("web");
  });
});
