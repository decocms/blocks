import { describe, expect, it } from "vitest";
import { vtexMiddleware } from "./mod";

/**
 * The VTEX app middleware wraps the framework's entire edge-cache layer, so it
 * is the last writer of Cache-Control on every response — including cache HITs.
 * These tests pin the two things that made that dangerous.
 */

// A response as the framework's cache layer would hand it over: public headers
// resolved from the page's cache profile, plus the CDN header.
function cachedResponse(): Response {
  return new Response("page", {
    headers: {
      "Cache-Control": "public, max-age=120, s-maxage=900, stale-while-revalidate=1800",
      "CDN-Cache-Control": "public, max-age=900",
    },
  });
}

const next = async () => cachedResponse();

describe("vtexMiddleware cache headers", () => {
  it("leaves the cache layer's headers alone for an anonymous request", async () => {
    const res = await vtexMiddleware(new Request("https://store.com/"), next);
    // Used to be downgraded to vtexCacheControl's generic `s-maxage=60`,
    // throwing away the profile the cache layer had resolved.
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=900");
  });

  it("forces private headers and clears the CDN header when logged in", async () => {
    const req = new Request("https://store.com/", {
      // extractVtexContext treats any VtexIdclientAutCookie* as authenticated.
      headers: { cookie: "VtexIdclientAutCookie_store=abc123" },
    });
    const res = await vtexMiddleware(req, next);

    expect(res.headers.get("Cache-Control")).toContain("no-store");
    // Cloudflare gives CDN-Cache-Control precedence, so leaving the public
    // value behind would cache a personalized page at the CDN regardless of
    // the private Cache-Control next to it.
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
  });
});
