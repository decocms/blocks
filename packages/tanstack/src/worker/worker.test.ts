// @vitest-environment node
/**
 * `createDecoWorker` end to end, with the Cache API, the CMS and TanStack
 * Start's server entry replaced by test doubles: the header matrix of every
 * always-on behaviour, and each option a site uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CSEG_PARAM } from "../shared.ts";
import { type CacheEvent, createDecoWorker, type DecoWorkerOptions } from "./index.ts";
import { segmentToken } from "./segment.ts";
import {
  html,
  installCache,
  type MemoryCache,
  POINTER,
  recordingEntry,
  recordMetrics,
  removeMetrics,
  snapshot,
  TestContext,
  testCMS,
  uninstallCache,
} from "./testing.ts";

const ORIGIN = "https://store.example.com";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130";
/** A start time for fake clocks (a stored copy records when it was stored). */
const T0 = 1_700_000_000_000;
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";

let cache: MemoryCache;
beforeEach(() => {
  cache = installCache();
});
afterEach(() => {
  uninstallCache();
  removeMetrics();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(
  options: Partial<DecoWorkerOptions> = {},
  respond?: (request: Request) => Response | Promise<Response>,
) {
  const entry = recordingEntry(respond);
  const worker = createDecoWorker({
    serverEntry: entry,
    // The test store declares its own host, so a draft link on ORIGIN previews.
    cms: testCMS(snapshot({ previewHosts: ["store.example.com"] })),
    site: "acme",
    buildHash: "abc123",
    ...options,
  });
  const ctx = new TestContext();
  const get = async (path: string, init: RequestInit & { ua?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", init.ua ?? DESKTOP_UA);
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const response = await worker.fetch(new Request(url, { ...init, headers }), {}, ctx);
    await ctx.settle();
    return response;
  };
  return { worker, entry, ctx, get };
}

describe("always on: liveness and v7's admin paths", () => {
  it("/deco/_liveness answers OK, uncached, without reaching the app", async () => {
    const { get, entry } = setup();
    const res = await get("/deco/_liveness");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(res.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(entry.served).toHaveLength(0);
  });

  it.each([
    "/deco/meta",
    "/deco/render",
    "/live/_meta",
    "/live/invoke/x",
    "/.decofile",
  ])("%s answers 404 and is never cached", async (path) => {
    const { get, entry } = setup();
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(entry.served).toHaveLength(0);
  });
});

describe("always on: security headers and Studio framing", () => {
  it("an HTML page may be framed by Studio and the site, with no X-Frame-Options", async () => {
    const { get } = setup();
    const res = await get("/");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(
      "frame-ancestors 'self' https://studio.decocms.com https://studio-stg.decocms.com https://decocms.com https://*.decocms.com https://*.deco.studio",
    );
    expect(res.headers.has("x-frame-options")).toBe(false);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
  });

  it("the site's enforced CSP gets frame-ancestors added; its report-only CSP is sent as is", async () => {
    const { get } = setup({
      csp: {
        enforce: ["default-src 'self'", "object-src 'none'"],
        reportOnly: "script-src 'self'; img-src https:",
        frameAncestors: ["https://*.editor.example.com"],
      },
    });
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; object-src 'none'; frame-ancestors 'self' https://studio.decocms.com https://studio-stg.decocms.com https://decocms.com https://*.decocms.com https://*.deco.studio https://*.editor.example.com",
    );
    expect(res.headers.get("content-security-policy-report-only")).toBe(
      "script-src 'self'; img-src https:",
    );
  });

  it("a site CSP that sets its own frame-ancestors keeps it", async () => {
    const { get } = setup({ csp: { enforce: "frame-ancestors 'none'" } });
    expect((await get("/")).headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("dev adds a Studio on this machine", async () => {
    const { get } = setup({ dev: true });
    expect((await get("/")).headers.get("content-security-policy")).toContain(
      "http://localhost:* http://127.0.0.1:*",
    );
  });

  it("non-HTML responses get none of them", async () => {
    const { get } = setup({}, () => Response.json({ ok: true }));
    const res = await get("/api/thing");
    expect(res.headers.has("content-security-policy")).toBe(false);
  });

  it("preload hints go on HTML responses", async () => {
    const { get } = setup({
      preload: { styles: ["/assets/app-123.css"], fonts: ["/fonts/a.woff2"] },
    });
    expect((await get("/")).headers.get("link")).toBe(
      "</assets/app-123.css>; rel=preload; as=style, </fonts/a.woff2>; rel=preload; as=font; crossorigin",
    );
  });

  it("a routes response gets no preload hints, only the app's pages do", async () => {
    const { get } = setup({
      preload: { styles: ["/assets/app-123.css"], fonts: ["/fonts/a.woff2"] },
      routes: (request) =>
        new URL(request.url).pathname.startsWith("/legacy")
          ? new Response("<html>other origin</html>", {
              headers: {
                "content-type": "text/html; charset=utf-8",
                link: "</old.css>; rel=preload; as=style",
              },
            })
          : null,
    });
    const proxied = await get("/legacy/page");
    expect(proxied.headers.get("link")).toBe("</old.css>; rel=preload; as=style");
    expect(proxied.headers.has("content-security-policy")).toBe(true);
    expect((await get("/")).headers.get("link")).toContain("/assets/app-123.css");
  });
});

describe("the edge cache", () => {
  it("a page is a MISS, then a HIT from the cache, keyed on build, revision and segment", async () => {
    const { get, entry } = setup();
    const first = await get("/");
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(first.headers.get("x-cache-profile")).toBe("static");
    expect(first.headers.get("x-cache-version")).toBe("abc123.rev-1");
    expect(first.headers.get("x-cache-segment")).toBe("device=desktop");
    expect(first.headers.get("cache-control")).toBe(
      "public, max-age=120, s-maxage=900, stale-while-revalidate=1800, stale-if-error=7200",
    );
    expect(first.headers.get("cdn-cache-control")).toBe("no-store");
    const second = await get("/");
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.text()).toBe("<!doctype html><p>/</p>");
    expect(entry.served).toHaveLength(1);
    const [key] = [...cache.entries.keys()];
    expect(key).toBe(`${ORIGIN}/?__v=abc123.rev-1&__seg=device%3Ddesktop`);
  });

  it("a new content revision gets new entries", async () => {
    const entry = recordingEntry();
    let revision = "rev-1";
    const cms = testCMS();
    const release = cms.forRelease.bind(cms);
    vi.spyOn(cms, "forRelease").mockImplementation(() => {
      const client = release();
      client.revision = async () => revision;
      return client;
    });
    const worker = createDecoWorker({ serverEntry: entry, cms, site: "acme", buildHash: "b" });
    const ctx = new TestContext();
    const get = async () => {
      const r = await worker.fetch(new Request(`${ORIGIN}/`), {}, ctx);
      await ctx.settle();
      return r;
    };
    expect((await get()).headers.get("x-cache")).toBe("MISS");
    expect((await get()).headers.get("x-cache")).toBe("HIT");
    revision = "rev-2";
    const after = await get();
    expect(after.headers.get("x-cache")).toBe("MISS");
    expect(after.headers.get("x-cache-version")).toBe("b.rev-2");
  });

  it("devices get their own entries; tracking params share one", async () => {
    const { get, entry } = setup();
    await get("/shoes?utm_source=x&gclid=1");
    expect((await get("/shoes")).headers.get("x-cache")).toBe("HIT");
    expect((await get("/shoes", { ua: PHONE_UA })).headers.get("x-cache")).toBe("MISS");
    expect(entry.served).toHaveLength(2);
  });

  it("programmatic fetches (Sec-Fetch-Dest: empty) get their own entries", async () => {
    const { get } = setup();
    await get("/shoes");
    const fetched = await get("/shoes", { headers: { "sec-fetch-dest": "empty" } });
    expect(fetched.headers.get("x-cache")).toBe("MISS");
  });

  it("stale-while-revalidate, then stale-if-error, then the origin's error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let fail = false;
    const { get, entry } = setup({}, () => (fail ? new Response("boom", { status: 503 }) : html()));
    await get("/shoes"); // listing: fresh 120, swr 900, sie 3600
    vi.setSystemTime(T0 + 200_000);
    const stale = await get("/shoes");
    expect(stale.headers.get("x-cache")).toBe("STALE-HIT");
    expect(entry.served).toHaveLength(2); // revalidated in the background
    vi.setSystemTime(T0 + 200_000 + 1_100_000);
    fail = true;
    const error = await get("/shoes");
    expect(error.headers.get("x-cache")).toBe("STALE-ERROR");
    expect(error.headers.get("x-cache-origin-status")).toBe("503");
    vi.setSystemTime(T0 + 200_000 + 5_000_000);
    const gone = await get("/shoes");
    expect(gone.status).toBe(503);
    expect(gone.headers.get("x-cache")).toBe("BYPASS");
    expect(gone.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("a degraded page is never stored, and a stale copy is preferred", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let degraded = true;
    const { get } = setup({}, () => html("x", degraded ? { "X-Deco-Degraded": "true" } : {}));
    const first = await get("/shoes");
    expect(first.headers.get("x-cache")).toBe("BYPASS");
    expect(first.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate");
    expect(cache.entries.size).toBe(0);
    degraded = false;
    await get("/shoes");
    vi.setSystemTime(T0 + 2_000_000); // past swr, within sie
    degraded = true;
    const res = await get("/shoes");
    expect(res.headers.get("x-cache")).toBe("STALE-ERROR");
    expect(res.headers.get("x-cache-reason")).toBe("degraded");
  });

  it("a stored HIT drops Cloudflare's cf-cache-status", async () => {
    const { get } = setup();
    await get("/");
    for (const response of cache.entries.values()) response.headers.set("cf-cache-status", "HIT");
    const hit = await get("/");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.has("cf-cache-status")).toBe(false);
  });

  it("non-GET requests pass through, uncached", async () => {
    const { get, entry } = setup();
    const res = await get("/_serverFn/abc", { method: "POST", body: "{}" });
    expect(res.headers.get("x-cache")).toBe("BYPASS");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(entry.served[0]?.method).toBe("POST");
  });

  it("dev never caches and tells the browser to revalidate", async () => {
    const { get } = setup({ dev: true });
    await get("/");
    const res = await get("/");
    expect(res.headers.get("x-cache")).toBe("BYPASS");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(cache.entries.size).toBe(0);
  });

  it("cacheProfiles changes a profile's values", async () => {
    const { get } = setup({
      cacheProfiles: { static: { browser: { fresh: 300 }, edge: { fresh: 1800 } } },
    });
    expect((await get("/")).headers.get("cache-control")).toBe(
      "public, max-age=300, s-maxage=1800, stale-while-revalidate=1800, stale-if-error=7200",
    );
  });
});

describe("per-visitor responses never reach the cache", () => {
  it('segment "private" (a signed-in shopper) is never served from or stored in the cache', async () => {
    const { get, entry } = setup({
      segment: (r) => (r.headers.get("cookie")?.includes("session=") ? "private" : {}),
    });
    await get("/");
    const signedIn = await get("/", { headers: { cookie: "session=1" } });
    expect(signedIn.headers.get("x-cache")).toBe("BYPASS");
    expect(signedIn.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(entry.served).toHaveLength(2);
    expect(cache.entries.size).toBe(1);
  });

  it("segment parts split the cache and show in X-Cache-Segment", async () => {
    const { get } = setup({
      segment: (r) => ({ region: r.headers.get("cf-region-code") ?? undefined }),
    });
    const sp = await get("/", { headers: { "cf-region-code": "SP" } });
    expect(sp.headers.get("x-cache-segment")).toBe("device=desktop|region=SP");
    expect((await get("/", { headers: { "cf-region-code": "RJ" } })).headers.get("x-cache")).toBe(
      "MISS",
    );
    expect((await get("/", { headers: { "cf-region-code": "SP" } })).headers.get("x-cache")).toBe(
      "HIT",
    );
  });

  it("a segment may merge device classes", async () => {
    const { get } = setup({
      segment: (r) => ({
        device: /iPhone|iPad|Android/.test(r.headers.get("user-agent") ?? "")
          ? "mobile"
          : "desktop",
      }),
    });
    await get("/", { ua: PHONE_UA });
    const tablet = await get("/", { ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" });
    expect(tablet.headers.get("x-cache")).toBe("HIT");
  });

  it("a request with Authorization is never cached", async () => {
    const { get } = setup();
    const res = await get("/", { headers: { authorization: "Bearer x" } });
    expect(res.headers.get("x-cache")).toBe("BYPASS");
    expect(cache.entries.size).toBe(0);
  });

  it("a private profile (/account, /cart) is never cached", async () => {
    const { get } = setup();
    for (const path of ["/account", "/cart/items", "/login"]) {
      const res = await get(path);
      expect(res.headers.get("x-cache"), path).toBe("BYPASS");
      expect(res.headers.get("cache-control"), path).toBe(
        "private, no-cache, no-store, must-revalidate",
      );
    }
    expect(cache.entries.size).toBe(0);
  });

  it("a response that says private, or sets a cookie that isn't safe, is not stored", async () => {
    const { get } = setup({}, (r) =>
      new URL(r.url).pathname === "/a"
        ? html("a", { "cache-control": "private" })
        : html("b", { "set-cookie": "session=1; Path=/" }),
    );
    expect((await get("/a")).headers.get("x-cache")).toBe("BYPASS");
    const b = await get("/b");
    expect(b.headers.get("x-cache")).toBe("BYPASS");
    expect(b.headers.get("set-cookie")).toBe("session=1; Path=/");
    expect(cache.entries.size).toBe(0);
  });

  it("a safe cookie reaches the visitor but not the stored copy", async () => {
    const { get } = setup({ safeCookies: ["vtex_segment"] }, () =>
      html("x", { "set-cookie": "vtex_segment=abc; Path=/" }),
    );
    const res = await get("/");
    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(res.headers.get("set-cookie")).toBe("vtex_segment=abc; Path=/");
    const [stored] = [...cache.entries.values()];
    expect(stored?.headers.has("set-cookie")).toBe(false);
  });

  it("server functions: a page load takes its page's profile, any other one is private", async () => {
    const { get } = setup({}, () => Response.json({ ok: true }));
    const page = await get(
      `/_serverFn/abc?payload=${encodeURIComponent(JSON.stringify({ data: { href: "/shoes" } }))}`,
    );
    expect(page.headers.get("x-cache-profile")).toBe("listing");
    expect(page.headers.get("x-cache")).toBe("MISS");
    const cart = await get(
      `/_serverFn/cart?payload=${encodeURIComponent(JSON.stringify({ data: {} }))}`,
    );
    expect(cart.headers.get("x-cache")).toBe("BYPASS");
    expect(cart.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate");
  });

  it("a page load's variant params (skuId) share one entry", async () => {
    const { get } = setup({}, () => Response.json({ ok: true }));
    const payload = (href: string) => encodeURIComponent(JSON.stringify({ data: { href } }));
    await get(`/_serverFn/abc?payload=${payload("/shirt/p")}`);
    const variant = await get(`/_serverFn/abc?payload=${payload("/shirt/p?skuId=42")}`);
    expect(variant.headers.get("x-cache")).toBe("HIT");
  });
});

describe("__cseg: the CDN caches navigation data only under a token that checks out", () => {
  const payload = encodeURIComponent(JSON.stringify({ data: { href: "/shoes" } }));

  it("the page's render gets the token; the matching server-function URL is CDN-cacheable", async () => {
    const { get, entry } = setup({}, () => html());
    await get("/");
    const token = entry.served[0]?.scope?.csegToken;
    expect(token).toBe(segmentToken({ device: "desktop" }, "abc123.rev-1"));
    const ok = await get(`/_serverFn/abc?payload=${payload}&${CSEG_PARAM}=${token}`);
    expect(ok.headers.get("cdn-cache-control")).toBe("public, max-age=120");
    const forged = await get(`/_serverFn/abc?payload=${payload}&${CSEG_PARAM}=deadbeef`);
    expect(forged.headers.get("cdn-cache-control")).toBe("no-store");
    expect(forged.headers.get("x-cache")).toBe("HIT"); // the token is not part of the edge key
    const otherDevice = await get(`/_serverFn/abc?payload=${payload}&${CSEG_PARAM}=${token}`, {
      ua: PHONE_UA,
    });
    expect(otherDevice.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("documents are never CDN-cacheable, and a private visitor gets no token", async () => {
    const { get, entry } = setup({ segment: (r) => (r.headers.has("cookie") ? "private" : {}) });
    const doc = await get("/");
    expect(doc.headers.get("cdn-cache-control")).toBe("no-store");
    await get("/", { headers: { cookie: "session=1" } });
    expect(entry.served[1]?.scope?.csegToken).toBeUndefined();
  });
});

describe("drafts", () => {
  const draftUrl = `/?__draft=${encodeURIComponent(POINTER)}`;

  it("a draft link renders the draft: header to the app, cookie stored, never cached, noindex", async () => {
    const { get, entry } = setup();
    await get("/"); // a cached release copy exists
    const res = await get(draftUrl);
    expect(entry.served.at(-1)?.headers.get("x-deco-draft")).toBe(POINTER);
    expect(entry.served.at(-1)?.scope?.draft).toBe(POINTER);
    expect(res.headers.get("x-cache")).toBe("BYPASS");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("set-cookie")).toBe(
      `__deco_draft=${encodeURIComponent(POINTER)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it("a draft keeps the origin's Vary and adds Cookie", async () => {
    const { get } = setup({}, () => html("x", { vary: "Accept-Encoding" }));
    const res = await get(draftUrl);
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Cookie");
  });

  it("the draft cookie keeps the preview going, and sets no cookie again", async () => {
    const { get, entry } = setup();
    const res = await get("/shoes", {
      headers: { cookie: `__deco_draft=${encodeURIComponent(POINTER)}` },
    });
    expect(entry.served[0]?.headers.get("x-deco-draft")).toBe(POINTER);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.has("set-cookie")).toBe(false);
  });

  it("the draft cookie is the one cms.draftCookie writes", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["store.example.com"] }));
    const { get } = setup({ cms });
    const request = new Request(`${ORIGIN}${draftUrl}`);
    expect((await get(draftUrl)).headers.get("set-cookie")).toBe(await cms.draftCookie(request));
    const off = new Request(`${ORIGIN}/?__draft=off`);
    expect((await get("/?__draft=off")).headers.get("set-cookie")).toBe(await cms.draftCookie(off));
  });

  it("?__draft=off ends the preview: the release, and the cookie expired", async () => {
    const { get, entry } = setup();
    const res = await get("/?__draft=off", {
      headers: { cookie: `__deco_draft=${encodeURIComponent(POINTER)}` },
    });
    expect(entry.served[0]?.headers.has("x-deco-draft")).toBe(false);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("a pointer that doesn't parse is no draft: the release, cached as usual", async () => {
    const { get, entry } = setup();
    const res = await get("/?__draft=junk");
    expect(entry.served[0]?.headers.has("x-deco-draft")).toBe(false);
    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(res.headers.has("x-robots-tag")).toBe(false);
  });

  it("an x-deco-draft header from outside never counts", async () => {
    const { get, entry } = setup();
    const res = await get("/", { headers: { "x-deco-draft": POINTER } });
    expect(entry.served[0]?.headers.has("x-deco-draft")).toBe(false);
    expect(res.headers.get("x-cache")).toBe("MISS");
  });

  it("a draft request's server function bypasses the cache too", async () => {
    const { get } = setup({}, () => Response.json({}));
    const payload = encodeURIComponent(JSON.stringify({ data: { href: "/shoes" } }));
    const res = await get(`/_serverFn/abc?payload=${payload}`, {
      headers: { cookie: `__deco_draft=${encodeURIComponent(POINTER)}` },
    });
    expect(res.headers.get("x-cache")).toBe("BYPASS");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(cache.entries.size).toBe(0);
  });
});

describe("A/B tests: the visitor's assignments", () => {
  const withTests = (experiments: Record<string, number>) =>
    testCMS(snapshot({ previewHosts: ["store.example.com"], experiments }));
  const segmentCookies = (res: Response) =>
    res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));
  const cookieValue = (setCookie: string) => setCookie.split(";")[0] as string;

  it("a first visit: the app gets the assignments, the response sets deco_segment", async () => {
    const { get, entry } = setup({ cms: withTests({ "buy-button": 100, "hero-copy": 0 }) });
    const res = await get("/");
    expect(entry.served[0]?.headers.get("x-deco-assignments")).toBe("buy-button");
    const [cookie, ...more] = segmentCookies(res);
    expect(more).toEqual([]);
    expect(cookie).toMatch(/^deco_segment=[^;]+; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
  });

  it("the cookie is written only when the assignments change", async () => {
    const { get, entry } = setup({ cms: withTests({ "buy-button": 100 }) });
    const first = segmentCookies(await get("/shoes"));
    expect(first).toHaveLength(1);
    const again = await get("/shoes", { headers: { cookie: cookieValue(first[0] as string) } });
    expect(segmentCookies(again)).toEqual([]);
    expect(entry.served.at(-1)?.headers.get("x-deco-assignments")).toBe("buy-button");
  });

  it("a new visitor served from the cache still gets their cookie; the stored copy has none", async () => {
    const { get, entry } = setup({ cms: withTests({ "buy-button": 50 }) });
    await get("/");
    const hit = await get("/");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(entry.served).toHaveLength(1);
    expect(segmentCookies(hit)).toHaveLength(1);
    for (const stored of cache.entries.values())
      expect(stored.headers.has("set-cookie")).toBe(false);
  });

  it("server-function calls are assigned too", async () => {
    const { get, entry } = setup({ cms: withTests({ "buy-button": 100 }) }, () =>
      Response.json({}),
    );
    const res = await get("/_serverFn/abc", { method: "POST" });
    expect(entry.served[0]?.headers.get("x-deco-assignments")).toBe("buy-button");
    expect(segmentCookies(res)).toHaveLength(1);
  });

  it("with no experiments: no header, no cookie", async () => {
    const { get, entry } = setup();
    const res = await get("/");
    expect(entry.served[0]?.headers.has("x-deco-assignments")).toBe(false);
    expect(segmentCookies(res)).toEqual([]);
  });

  it("an x-deco-assignments header from outside never reaches the app", async () => {
    const forged = { headers: { "x-deco-assignments": "buy-button" } };
    const none = setup();
    await none.get("/", forged);
    expect(none.entry.served[0]?.headers.has("x-deco-assignments")).toBe(false);
    const off = setup({ cms: withTests({ "buy-button": 0 }) });
    await off.get("/shoes", forged);
    expect(off.entry.served[0]?.headers.get("x-deco-assignments")).toBe("");
    const routed = setup({
      routes: (request) => html(request.headers.get("x-deco-assignments") ?? "none"),
    });
    expect(await (await routed.get("/hats", forged)).text()).toBe("none");
  });

  it("a draft is assigned from the draft's Experiments, and never writes deco_segment", async () => {
    // The draft adds a test the release doesn't have.
    const draft = {
      set: { Experiments: { __resolveType: "experiments", "buy-button": 100 } },
      delete: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(draft)),
    );
    const { get, entry } = setup({ cms: withTests({ "hero-copy": 0 }) });
    const res = await get(`/?__draft=${encodeURIComponent(POINTER)}`, {
      headers: { "x-deco-assignments": "hero-copy" },
    });
    expect(entry.served[0]?.headers.get("x-deco-draft")).toBe(POINTER);
    expect(entry.served[0]?.headers.get("x-deco-assignments")).toBe("buy-button");
    expect(segmentCookies(res)).toEqual([]);
  });

  it("assets and the liveness check are never assigned", async () => {
    const { get, entry } = setup(
      { cms: withTests({ "buy-button": 100 }) },
      () => new Response("x", { headers: { "content-type": "text/javascript" } }),
    );
    expect(segmentCookies(await get("/assets/main-AbCdEf12.js"))).toEqual([]);
    expect(entry.served[0]?.headers.has("x-deco-assignments")).toBe(false);
    expect(segmentCookies(await get("/deco/_liveness"))).toEqual([]);
  });

  it("over plain http (local development) the cookie isn't Secure", async () => {
    const { get } = setup({ cms: withTests({ "buy-button": 100 }) });
    const [cookie] = segmentCookies(await get("http://localhost:5173/"));
    expect(cookie).not.toContain("Secure");
  });
});

describe("the draft host allowlist (v7's, in the worker)", () => {
  const link = (host: string) => `https://${host}/?__draft=${encodeURIComponent(POINTER)}`;

  async function previews(options: Partial<DecoWorkerOptions>, host: string): Promise<boolean> {
    const { get, entry } = setup(options);
    const res = await get(link(host));
    const rendered = entry.served[0]?.headers.get("x-deco-draft") === POINTER;
    // The cookie and the headers agree with what the app rendered.
    expect(res.headers.has("set-cookie"), host).toBe(rendered);
    expect(res.headers.get("x-robots-tag") === "noindex, nofollow", host).toBe(rendered);
    return rendered;
  }

  it("with no preview hosts declared, only the site's Deco hosts preview (v7's default, not blocks' every host)", async () => {
    const cms = testCMS(snapshot());
    expect((await cms.settings()).preview.hosts).toEqual(["*"]); // blocks' own default stays
    for (const host of ["store.example.com", "www.store.example.com", "localhost:5173"]) {
      expect(await previews({ cms }, host), host).toBe(false);
    }
    for (const host of ["acme.deco.site", "acme.deco-cx.workers.dev"]) {
      expect(await previews({ cms }, host), host).toBe(true);
    }
    expect(await previews({ cms, previewHosts: ["localhost:5173"] }, "localhost:5173")).toBe(true);
  });

  it('a CMS block that declares "*" previews on every host', async () => {
    const cms = testCMS(snapshot({ previewHosts: ["*"] }));
    for (const host of ["store.example.com", "localhost:5173", "acme.deco.site"]) {
      expect(await previews({ cms }, host), host).toBe(true);
    }
  });

  it("the CMS block's preview hosts: only those, plus the site's Deco hosts", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.store.example.com"] }));
    for (const host of [
      "staging.store.example.com",
      "acme.deco.site",
      "acme.deco-cx.workers.dev",
    ]) {
      expect(await previews({ cms }, host), host).toBe(true);
    }
    for (const host of [
      "store.example.com",
      "other.deco.site",
      "xacme.deco.site",
      "www.acme.deco.site",
      "acme.deco.site.attacker.example",
      "1a2b3c-acme.deco-cx.workers.dev",
      "acme.deco.site:8443",
      "deco.site",
    ]) {
      expect(await previews({ cms }, host), host).toBe(false);
    }
  });

  it("the Deco hosts are named after site, case-insensitively, and exactly", async () => {
    const cms = testCMS(snapshot({ previewHosts: [] }));
    expect(await previews({ cms, site: "Acme" }, "ACME.deco.site")).toBe(true);
    expect(await previews({ cms, site: "acme" }, "store.example.com")).toBe(false);
  });

  it("previewHosts replaces the CMS block's list (v7's DECO_ALLOWED_PREVIEW_HOSTS); the Deco hosts stay", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.store.example.com"] }));
    const previewHosts = ["localhost:5173", "Preview.Store.Example.com"];
    expect(await previews({ cms, previewHosts }, "localhost:5173")).toBe(true);
    expect(await previews({ cms, previewHosts }, "preview.store.example.com")).toBe(true);
    expect(await previews({ cms, previewHosts }, "acme.deco.site")).toBe(true);
    expect(await previews({ cms, previewHosts }, "staging.store.example.com")).toBe(false);
    expect(await previews({ cms, previewHosts }, "localhost:5174")).toBe(false);
  });

  it("an empty previewHosts list leaves only the Deco hosts (v7's default)", async () => {
    expect(await previews({ previewHosts: [] }, "store.example.com")).toBe(false);
    expect(await previews({ previewHosts: [] }, "acme.deco.site")).toBe(true);
  });

  it('previewHosts: "none" is the kill switch: no host previews, the Deco hosts and "*" included', async () => {
    const cms = testCMS(snapshot({ previewHosts: ["*"] }));
    for (const host of ["acme.deco.site", "acme.deco-cx.workers.dev", "store.example.com"]) {
      expect(await previews({ cms, previewHosts: "none" }, host), host).toBe(false);
      expect(await previews({ cms, previewHosts: ["localhost:5173", "none"] }, host), host).toBe(
        false,
      );
    }
  });

  it("a refused host still ends a preview (?__draft=off expires the cookie anywhere)", async () => {
    const { get } = setup({ previewHosts: "none" });
    expect((await get("/?__draft=off")).headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("a refused draft request is served the cached release", async () => {
    const { get, entry } = setup({ previewHosts: "none" });
    await get("/");
    const res = await get(`/?__draft=${encodeURIComponent(POINTER)}`);
    expect(res.headers.get("x-cache")).toBe("MISS"); // its own key (the query differs), but cached
    expect(entry.served.every((s) => !s.headers.has("x-deco-draft"))).toBe(true);
  });
});

describe("CMS redirects, routes and assets", () => {
  it("a CMS redirect answers before any route, keeping the query", async () => {
    const routes = vi.fn(() => null);
    const { get, entry } = setup({ routes });
    const res = await get("/old-shoes?color=red");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/shoes?color=red");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(routes).not.toHaveBeenCalled();
    expect(entry.served).toHaveLength(0);
  });

  it("routes answer first; null falls through to the app", async () => {
    const { get, entry } = setup({
      routes: (request) =>
        new URL(request.url).pathname.startsWith("/checkout")
          ? new Response("proxied", {
              headers: { "set-cookie": "a=1", "content-type": "text/plain" },
            })
          : null,
    });
    const proxied = await get("/checkout/cart");
    expect(await proxied.text()).toBe("proxied");
    expect(proxied.headers.get("cdn-cache-control")).toBe("no-store");
    expect(entry.served).toHaveLength(0);
    await get("/shoes");
    expect(entry.served).toHaveLength(1);
  });

  it("routes see the checked draft", async () => {
    let seen: string | null = null;
    const { get } = setup({
      routes: (request) => {
        seen = request.headers.get("x-deco-draft");
        return new Response("x");
      },
    });
    await get(`/anything?__draft=${encodeURIComponent(POINTER)}`);
    expect(seen).toBe(POINTER);
  });

  it("fingerprinted assets and fonts are immutable", async () => {
    const { get } = setup(
      {},
      () => new Response("body{}", { headers: { "content-type": "text/css" } }),
    );
    for (const path of [
      "/assets/app-AbCdEf12.css",
      "/_build/assets/main-1234abcd.js",
      "/fonts/a.woff2",
    ]) {
      const res = await get(path);
      expect(res.headers.get("cache-control"), path).toBe("public, max-age=31536000, immutable");
    }
  });

  it("an asset path the app answers with HTML is a 404, not a page", async () => {
    const { get } = setup();
    expect((await get("/assets/missing-AbCdEf12.js")).status).toBe(404);
  });

  it("x-page-status gives the document its status", async () => {
    const { get } = setup({}, () => html("not found", { "x-page-status": "404" }));
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.has("x-page-status")).toBe(false);
    expect(res.headers.get("x-cache")).toBe("BYPASS");
    expect(cache.entries.size).toBe(0);
  });
});

describe("Set-Cookie: one header per cookie (name + Domain + Path, v7 #642)", () => {
  it("keeps the last of each cookie, and every scope of a sign-out", async () => {
    const { get } = setup({}, () => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "cart=1; Path=/");
      headers.append("set-cookie", "cart=2; Path=/");
      headers.append("set-cookie", "token=; Max-Age=0; Path=/");
      headers.append("set-cookie", "token=; Max-Age=0; Path=/; Domain=www.store.example.com");
      headers.append("set-cookie", "token=; Max-Age=0; Path=/; Domain=.store.example.com");
      headers.append("set-cookie", "token=; Max-Age=0; Path=/; domain=STORE.example.com");
      return new Response("x", { headers });
    });
    expect((await get("/api/logout")).headers.getSetCookie()).toEqual([
      "cart=2; Path=/",
      "token=; Max-Age=0; Path=/",
      "token=; Max-Age=0; Path=/; Domain=www.store.example.com",
      "token=; Max-Age=0; Path=/; domain=STORE.example.com",
    ]);
  });
});

describe("purge", () => {
  it("POST /_cache/purge with the token drops a path's entries for every device", async () => {
    const { get, worker, ctx } = setup({ purgeToken: (env) => (env as { T?: string }).T });
    await get("/shoes");
    await get("/shoes", { ua: PHONE_UA });
    expect(cache.entries.size).toBe(2);
    const purge = (auth: string) =>
      worker.fetch(
        new Request(`${ORIGIN}/_cache/purge`, {
          method: "POST",
          headers: { authorization: auth },
          body: JSON.stringify({ paths: ["/shoes"] }),
        }),
        { T: "secret" },
        ctx,
      );
    expect((await purge("Bearer nope")).status).toBe(401);
    const res = await purge("Bearer secret");
    expect(await res.json()).toEqual({
      purged: ["/shoes (device=mobile)", "/shoes (device=desktop)"],
      total: 2,
    });
    expect(cache.entries.size).toBe(0);
  });

  it("is off without purgeToken", async () => {
    const { worker, ctx } = setup();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/_cache/purge`, { method: "POST", body: "{}" }),
      {},
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe("onCache", () => {
  it("reports each page and server-function request: profile, decision, duration, status", async () => {
    const events: CacheEvent[] = [];
    const { get } = setup({ onCache: (e) => events.push(e) });
    await get("/");
    await get("/");
    await get("/deco/_liveness");
    await get("/account");
    expect(events.map(({ profile, decision, status }) => ({ profile, decision, status }))).toEqual([
      { profile: "static", decision: "MISS", status: 200 },
      { profile: "static", decision: "HIT", status: 200 },
      { profile: "private", decision: "BYPASS", status: 200 },
    ]);
    expect(events.every((e) => typeof e.ms === "number" && e.ms >= 0)).toBe(true);
  });

  it("a throwing hook never breaks the response", async () => {
    const { get } = setup({
      onCache: () => {
        throw new Error("metrics down");
      },
    });
    expect((await get("/")).status).toBe(200);
  });
});

describe("http.server.request.duration", () => {
  /** The test store with a product template next to the home page and its redirect. */
  function storeCMS() {
    const content = snapshot({ previewHosts: ["store.example.com"] });
    (content.blocks as Record<string, unknown>).Product = {
      __resolveType: "page",
      path: "/:slug/p",
      sections: [],
    };
    return testCMS(content);
  }

  const labels = (points: ReturnType<typeof recordMetrics>) => points.map((p) => p.labels);

  it("a page: the content's route template, method, status class, cache decision and device", async () => {
    const points = recordMetrics();
    const { get } = setup({ cms: storeCMS() });
    await get("/blue-shoes/p");
    await get("/blue-shoes/p", { ua: PHONE_UA });
    await get("/red-shoes/p");
    await get("/");
    expect(points.every((p) => p.name === "http.server.request.duration")).toBe(true);
    expect(points.every((p) => p.seconds >= 0 && p.seconds < 5)).toBe(true);
    expect(labels(points)).toEqual([
      {
        "http.route": "/:slug/p",
        "http.request.method": "GET",
        status_class: "2xx",
        cache: "MISS",
        device: "desktop",
      },
      {
        "http.route": "/:slug/p",
        "http.request.method": "GET",
        status_class: "2xx",
        cache: "MISS",
        device: "mobile",
      },
      {
        "http.route": "/:slug/p",
        "http.request.method": "GET",
        status_class: "2xx",
        cache: "MISS",
        device: "desktop",
      },
      {
        "http.route": "/",
        "http.request.method": "GET",
        status_class: "2xx",
        cache: "MISS",
        device: "desktop",
      },
    ]);
  });

  it("a cached page is a HIT; a stale copy served counts as a HIT too", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const points = recordMetrics();
    const { get } = setup();
    await get("/");
    await get("/");
    vi.setSystemTime(T0 + 1_000_000);
    expect((await get("/")).headers.get("x-cache")).toBe("STALE-HIT");
    expect(points.map((p) => p.labels.cache)).toEqual(["MISS", "HIT", "HIT"]);
  });

  it("never the raw path: a path no template matches is unmatched", async () => {
    const points = recordMetrics();
    const { get } = setup({ cms: storeCMS() }, () => new Response("nope", { status: 404 }));
    await get("/some/visitor/typed/this?q=1");
    expect(labels(points)).toEqual([
      {
        "http.route": "unmatched",
        "http.request.method": "GET",
        status_class: "4xx",
        cache: "BYPASS",
        device: "desktop",
      },
    ]);
  });

  it("paths the worker knows get fixed templates; every CMS redirect is one route", async () => {
    const points = recordMetrics();
    const { get } = setup({}, (request) =>
      new URL(request.url).pathname.startsWith("/assets/")
        ? new Response("x", { headers: { "content-type": "text/javascript" } })
        : html(),
    );
    await get("/deco/_liveness");
    await get("/assets/main-AbCdEf123.js");
    await get("/_serverFn/abc", { method: "POST", body: "{}" });
    await get("/old-shoes");
    await get("/live/_meta");
    expect(
      labels(points).map((l) => [l["http.route"], l["http.request.method"], l.status_class]),
    ).toEqual([
      ["/deco/_liveness", "GET", "2xx"],
      ["/assets/*", "GET", "2xx"],
      ["/_serverFn/*", "POST", "2xx"],
      ["redirect", "GET", "3xx"],
      ["unmatched", "GET", "4xx"],
    ]);
  });

  it("an upstream's X-Cache never counts: only the worker's own cache decides", async () => {
    const points = recordMetrics();
    const { get } = setup({
      routes: () =>
        new Response("proxied", { headers: { "X-Cache": "HIT", "content-type": "text/plain" } }),
    });
    await get("/api/proxied");
    expect(labels(points).map((l) => [l["http.route"], l.cache])).toEqual([
      ["unmatched", "BYPASS"],
    ]);
  });

  it("an unknown method is _OTHER; a draft is DRAFT", async () => {
    const points = recordMetrics();
    const { get } = setup();
    await get("/", { method: "PROPFIND" });
    await get(`/?__draft=${encodeURIComponent(POINTER)}`);
    expect(labels(points).map((l) => [l["http.request.method"], l.cache])).toEqual([
      ["_OTHER", "BYPASS"],
      ["GET", "DRAFT"],
    ]);
  });

  it("a request that throws is a 5xx, and the error still reaches the runtime", async () => {
    const points = recordMetrics();
    const { get, ctx } = setup({}, () => {
      throw new Error("render failed");
    });
    await expect(get("/")).rejects.toThrow("render failed");
    await ctx.settle();
    expect(labels(points)).toEqual([
      {
        "http.route": "/",
        "http.request.method": "GET",
        status_class: "5xx",
        cache: "BYPASS",
        device: "desktop",
      },
    ]);
  });

  it("reads the release's pages once per revision", async () => {
    recordMetrics();
    const cms = storeCMS();
    const forRelease = cms.forRelease.bind(cms);
    let pageLists = 0;
    cms.forRelease = () => {
      const client = forRelease();
      return {
        ...client,
        revision: () => client.revision(),
        resolve: client.resolve.bind(client),
        list: (type: string, options?: object) => {
          if (type === "page") pageLists++;
          return client.list(type, options);
        },
      } as ReturnType<typeof forRelease>;
    };
    const { get } = setup({ cms });
    await get("/blue-shoes/p");
    await get("/red-shoes/p");
    await get("/");
    expect(pageLists).toBe(1);
  });

  it("a failed page read is tried again on the next request", async () => {
    const points = recordMetrics();
    const cms = storeCMS();
    const forRelease = cms.forRelease.bind(cms);
    let fail = true;
    cms.forRelease = () => {
      const client = forRelease();
      return {
        ...client,
        revision: () => client.revision(),
        resolve: client.resolve.bind(client),
        list: (type: string, options?: object) => {
          if (type === "page" && fail) {
            fail = false;
            return Promise.reject(new Error("store down"));
          }
          return client.list(type, options);
        },
      } as ReturnType<typeof forRelease>;
    };
    const { get } = setup({ cms });
    await get("/blue-shoes/p");
    await get("/blue-shoes/p");
    expect(points.map((p) => p.labels["http.route"])).toEqual(["unmatched", "/:slug/p"]);
  });

  it("costs nothing with telemetry off: no point, and the pages are never listed", async () => {
    for (const off of [() => removeMetrics(), () => recordMetrics({ measuring: false })]) {
      off();
      const cms = storeCMS();
      const forRelease = cms.forRelease.bind(cms);
      const listed: string[] = [];
      cms.forRelease = () => {
        const client = forRelease();
        return {
          revision: () => client.revision(),
          resolve: client.resolve.bind(client),
          list: (type: string, options?: object) => {
            listed.push(type);
            return client.list(type, options);
          },
        } as ReturnType<typeof forRelease>;
      };
      const { get } = setup({ cms });
      expect((await get("/blue-shoes/p")).status).toBe(200);
      expect(listed).not.toContain("page");
    }
  });

  it("a sink that throws never breaks the response", async () => {
    recordMetrics({ throws: true });
    const { get } = setup({ cms: storeCMS() });
    expect((await get("/blue-shoes/p")).status).toBe(200);
    expect((await get("/deco/_liveness")).status).toBe(200);
  });
});
