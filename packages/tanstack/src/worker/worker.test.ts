// @vitest-environment node
/**
 * `createDecoWorker` end to end, with the Cache API, the CMS and TanStack
 * Start's server entry replaced by test doubles: the header matrix of every
 * always-on behaviour, and each option a site uses.
 */
import {
  assign,
  newVisitor,
  parseVisitor,
  serializeVisitor,
  type Visitor,
} from "@decocms/blocks/experiments";
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

/** A visitor who has been here before: their cookie, as the worker wrote it. */
const RETURNING = `deco_segment=${serializeVisitor(newVisitor())}`;

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
  const get = async (path: string, init: RequestInit & { ua?: string; firstVisit?: true } = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", init.ua ?? DESKTOP_UA);
    // A returning visitor unless the test says otherwise, so no visitor cookie joins its own.
    const cookie = headers.get("cookie");
    if (!init.firstVisit && !cookie?.includes("deco_segment=")) {
      headers.set("cookie", cookie ? `${cookie}; ${RETURNING}` : RETURNING);
    }
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
    const [key] = cache.pageKeys();
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
    for (const response of cache.pages()) response.headers.set("cf-cache-status", "HIT");
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
    expect(cache.pageKeys()).toHaveLength(1);
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
    const [stored] = cache.pages();
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

describe("the edge cache keys on the request's assignments", () => {
  /** Two visitors on opposite sides of a 50% `hero` test. */
  function visitorsAcross(): { inside: Visitor; outside: Visitor } {
    let inside: Visitor | undefined;
    let outside: Visitor | undefined;
    while (!inside || !outside) {
      const v = newVisitor();
      if (assign({ hero: 50 }, v).hero) inside ??= v;
      else outside ??= v;
    }
    return { inside, outside };
  }
  const as = (v: Visitor) => ({ headers: { cookie: `deco_segment=${serializeVisitor(v)}` } });
  const BF = { start: "2026-11-27T00:00:00Z", end: "2026-12-01T23:59:59Z" };

  function assigned(content: Parameters<typeof snapshot>[0]) {
    return setup({ cms: testCMS(snapshot({ previewHosts: ["store.example.com"], ...content })) });
  }

  it("visitors on opposite sides of a test get their own entries; the same side shares one", async () => {
    const { get, entry } = assigned({ experiments: { hero: 50 } });
    const { inside, outside } = visitorsAcross();
    let another = newVisitor();
    while (!assign({ hero: 50 }, another).hero) another = newVisitor();
    expect((await get("/", as(inside))).headers.get("x-cache")).toBe("MISS");
    expect((await get("/", as(outside))).headers.get("x-cache")).toBe("MISS");
    expect((await get("/", as(another))).headers.get("x-cache")).toBe("HIT");
    expect(entry.served).toHaveLength(2);
    expect(cache.pageKeys().sort()).toEqual([
      `${ORIGIN}/?__v=abc123.rev-1&__seg=device%3Ddesktop`,
      `${ORIGIN}/?__v=abc123.rev-1&__seg=device%3Ddesktop&__a=x%3Dhero`,
    ]);
  });

  it("the visitor id is never in the key", async () => {
    const { get } = assigned({ experiments: { hero: 50 } });
    const { inside, outside } = visitorsAcross();
    await get("/", as(inside));
    await get("/", as(outside));
    for (const key of cache.pageKeys()) {
      expect(key).not.toContain(inside.id);
      expect(key).not.toContain(outside.id);
    }
  });

  it("a test at 0 or 100 decides the same for everyone: one entry", async () => {
    const { get, entry } = assigned({ experiments: { off: 0, all: 100 } });
    const { inside, outside } = visitorsAcross();
    await get("/", as(inside));
    expect((await get("/", as(outside))).headers.get("x-cache")).toBe("HIT");
    expect(entry.served).toHaveLength(1);
    expect(cache.pageKeys()[0]).toContain("&__a=x%3Dall");
  });

  it("a campaign starting changes the key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(BF.start) - 60_000);
    const { get, entry } = assigned({ campaigns: { "black-friday": BF } });
    expect((await get("/")).headers.get("x-cache")).toBe("MISS");
    expect((await get("/")).headers.get("x-cache")).toBe("HIT");
    vi.setSystemTime(Date.parse(BF.start) + 1_000);
    expect((await get("/")).headers.get("x-cache")).toBe("MISS");
    expect(entry.served).toHaveLength(2);
    expect(cache.pageKeys().at(-1)).toContain("&__a=c%3Dblack-friday");
  });

  it("the CDN token follows the assignments", async () => {
    const { get, entry } = assigned({ experiments: { hero: 50 } });
    const { inside, outside } = visitorsAcross();
    await get("/", as(inside));
    await get("/", as(outside));
    const [a, b] = entry.served.map((s) => s.scope?.csegToken);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("previews (a draft, an old release, a preview time) never share the live entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ set: {}, delete: [] })),
    );
    const { get, entry } = assigned({ campaigns: { "black-friday": BF } });
    await get("/");
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    for (const version of [POINTER, SHA, `${SHA}?__at=${encodeURIComponent(BF.start)}`]) {
      const res = await get(`/?__draft=${encodeURIComponent(version)}`);
      expect(res.headers.get("x-cache")).toBe("BYPASS");
    }
    expect(entry.served).toHaveLength(4);
    expect(cache.pageKeys()).toHaveLength(1);
  });

  it("a first visit is keyed on its new visitor's side, and a hit still sets that visitor's cookie", async () => {
    const { get, entry } = assigned({ experiments: { hero: 50 } });
    const sides = new Set<boolean>();
    for (let i = 0; i < 12; i++) {
      const res = await get("/", { firstVisit: true });
      const cookies = res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));
      expect(cookies).toHaveLength(1);
      const value = (cookies[0] as string).split(";")[0]?.slice("deco_segment=".length);
      const visitor = parseVisitor(value);
      expect(visitor).not.toBe(null);
      const side = assign({ hero: 50 }, visitor).hero === true;
      expect(res.headers.get("x-cache")).toBe(sides.has(side) ? "HIT" : "MISS");
      sides.add(side);
    }
    // One render per side, each keyed on the side its visitor landed on.
    expect(entry.served).toHaveLength(sides.size);
    const keyed = cache.pageKeys().map((key) => key.includes("&__a=x%3Dhero"));
    expect(new Set(keyed)).toEqual(sides);
  });

  it("a site without experiments or campaigns keys as before", async () => {
    const { get } = setup();
    await get("/");
    expect(cache.pageKeys()).toEqual([`${ORIGIN}/?__v=abc123.rev-1&__seg=device%3Ddesktop`]);
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

describe("the visitor", () => {
  const segmentCookies = (res: Response) =>
    res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));
  const cookieValue = (setCookie: string) => setCookie.split(";")[0] as string;
  const forwarded = (headers: Headers | undefined) =>
    parseVisitor(headers?.get("x-deco-visitor") ?? null);

  it("a first visit: the app gets a new visitor, the response sets deco_segment once", async () => {
    const { get, entry } = setup();
    const res = await get("/", { firstVisit: true });
    const visitor = forwarded(entry.served[0]?.headers);
    expect(visitor?.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const [cookie, ...more] = segmentCookies(res);
    expect(more).toEqual([]);
    expect(cookie).toMatch(/^deco_segment=[^;]+; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
    expect(cookieValue(cookie as string)).toBe(`deco_segment=${serializeVisitor(visitor!)}`);
  });

  it("a returning visitor keeps their id and gets no cookie", async () => {
    const { get, entry } = setup();
    const [first] = segmentCookies(await get("/shoes", { firstVisit: true }));
    const again = await get("/shoes", { headers: { cookie: cookieValue(first as string) } });
    expect(segmentCookies(again)).toEqual([]);
    expect(forwarded(entry.served.at(-1)?.headers)?.id).toBe(
      forwarded(entry.served[0]?.headers)?.id,
    );
  });

  it("a v7 visitor gets an id once, their stored decisions kept", async () => {
    const v7 = btoa(
      encodeURIComponent(
        JSON.stringify({ active: ["hero"], inactiveDrawn: [], pct: { hero: 50 } }),
      ),
    );
    const { get, entry } = setup();
    const res = await get("/", { headers: { cookie: `deco_segment=${v7}` } });
    const visitor = forwarded(entry.served[0]?.headers);
    expect(visitor?.active).toEqual(["hero"]);
    expect(segmentCookies(res)).toHaveLength(1);
  });

  it("a new visitor served from the cache still gets their cookie; the stored copy has none", async () => {
    const { get, entry } = setup();
    await get("/", { firstVisit: true });
    const hit = await get("/", { firstVisit: true });
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(entry.served).toHaveLength(1);
    expect(segmentCookies(hit)).toHaveLength(1);
    for (const stored of cache.entries.values())
      expect(stored.headers.has("set-cookie")).toBe(false);
  });

  it("server-function calls get the visitor too", async () => {
    const { get, entry } = setup({}, () => Response.json({}));
    const res = await get("/_serverFn/abc", { method: "POST", firstVisit: true });
    expect(forwarded(entry.served[0]?.headers)).not.toBe(null);
    expect(segmentCookies(res)).toHaveLength(1);
  });

  it("an x-deco-visitor header from outside never reaches the app", async () => {
    const forged = serializeVisitor({ ...newVisitor(), id: "AAAAAAAAAAAAAAAAAAAAAA" });
    const init = { headers: { "x-deco-visitor": forged }, firstVisit: true } as const;
    const page = setup();
    await page.get("/", init);
    expect(forwarded(page.entry.served[0]?.headers)?.id).not.toBe("AAAAAAAAAAAAAAAAAAAAAA");
    const routed = setup({
      routes: (request) => html(request.headers.get("x-deco-visitor") ?? "none"),
    });
    expect(await (await routed.get("/hats", init)).text()).toBe("none");
  });

  it("a preview (a draft) gets the visitor but never writes deco_segment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ set: {}, delete: [] })),
    );
    const { get, entry } = setup();
    const res = await get(`/?__draft=${encodeURIComponent(POINTER)}`, { firstVisit: true });
    expect(entry.served[0]?.headers.get("x-deco-draft")).toBe(POINTER);
    expect(forwarded(entry.served[0]?.headers)).not.toBe(null);
    expect(segmentCookies(res)).toEqual([]);
  });

  it("assets and the liveness check never read the visitor", async () => {
    const { get, entry } = setup(
      {},
      () => new Response("x", { headers: { "content-type": "text/javascript" } }),
    );
    expect(segmentCookies(await get("/assets/main-AbCdEf12.js", { firstVisit: true }))).toEqual([]);
    expect(entry.served[0]?.headers.has("x-deco-visitor")).toBe(false);
    expect(segmentCookies(await get("/deco/_liveness", { firstVisit: true }))).toEqual([]);
  });

  it("over plain http (local development) the cookie isn't Secure", async () => {
    const { get } = setup();
    const [cookie] = segmentCookies(await get("http://localhost:5173/", { firstVisit: true }));
    expect(cookie).not.toContain("Secure");
  });
});

describe("the version: an old release from a Studio link", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const segmentCookies = (res: Response) =>
    res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));

  it("a release SHA on a preview host is the version the app reads, kept in the draft cookie", async () => {
    const { get, entry } = setup();
    const res = await get(`/?__draft=${SHA}`, { firstVisit: true });
    expect(entry.served[0]?.headers.get("x-deco-draft")).toBe(SHA);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`__deco_draft=${SHA};`))).toBe(true);
    expect(segmentCookies(res)).toEqual([]);
  });

  it("with the preview time and forced tests on it", async () => {
    const version = `${SHA}?__at=${encodeURIComponent("2026-11-28T10:00:00-03:00")}&__test=${encodeURIComponent("hero=on")}`;
    const { get, entry } = setup();
    await get(`/?__draft=${encodeURIComponent(version)}`);
    expect(entry.served[0]?.headers.get("x-deco-draft")).toBe(version);
  });

  it("a preview time typed by hand, unencoded, reads as @decocms/blocks reads it", async () => {
    const version = `${SHA}?__at=2026-11-28T10:00:00-03:00`;
    const { get, entry } = setup();
    const res = await get(`/?__draft=${version}`, { firstVisit: true });
    expect(entry.served[0]?.headers.get("x-deco-draft")).toBe(version);
    expect(segmentCookies(res)).toEqual([]);
  });

  it("on a host that may not preview, or when it doesn't parse, the request gets the current release", async () => {
    const { get, entry } = setup();
    await get(`https://elsewhere.example.com/?__draft=${SHA}`);
    await get(`/?__draft=${SHA.slice(1)}`);
    await get(`/?__draft=${encodeURIComponent(`${SHA}?__at=yesterday`)}`);
    await get(`/?__draft=${encodeURIComponent(`${SHA}?page=2`)}`);
    for (const served of entry.served) expect(served.headers.has("x-deco-draft")).toBe(false);
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
  const purgeRequest = (body: unknown, auth = "Bearer secret") =>
    new Request(`${ORIGIN}/_cache/purge`, {
      method: "POST",
      headers: { authorization: auth },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const as = (v: Visitor) => ({ headers: { cookie: `deco_segment=${serializeVisitor(v)}` } });
  const TABLET_UA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148";

  it("v7's request: a Bearer token and { paths, countries, salesChannels, regionIds }; v7's answer", async () => {
    const { get, worker, ctx } = setup({
      purgeToken: (env) => (env as { T?: string }).T,
      segment: (r) => ({
        salesChannel: r.headers.get("x-sc") ?? undefined,
        regionId: r.headers.get("x-region") ?? undefined,
      }),
    });
    const copies: [string, Parameters<typeof get>[1]][] = [
      ["/shoes", {}],
      ["/shoes", { headers: { "x-sc": "2" } }],
      ["/shoes", { headers: { "x-sc": "2", "x-region": "south" } }],
    ];
    for (const [path, init] of copies) await get(path, init);
    await get("/hats");
    const res = await worker.fetch(
      purgeRequest({
        paths: ["/shoes"],
        countries: ["BR", "US"],
        salesChannels: ["1", "2"],
        regionIds: ["south"],
      }),
      { T: "secret" },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      purged: [
        "/shoes (device=desktop)",
        "/shoes (device=desktop|salesChannel=2)",
        "/shoes (device=desktop|regionId=south|salesChannel=2)",
      ],
      total: 3,
    });
    for (const [path, init] of copies) {
      expect((await get(path, init)).headers.get("x-cache")).toBe("MISS");
    }
    expect((await get("/hats")).headers.get("x-cache")).toBe("HIT");
  });

  it("exact paths only, as v7: /shoes never drops /shoes?page=2", async () => {
    const { get, worker, ctx } = setup({ purgeToken: () => "secret" });
    await get("/shoes");
    await get("/shoes?page=2");
    const res = await worker.fetch(purgeRequest({ paths: ["/shoes"] }), {}, ctx);
    expect(await res.json()).toEqual({ purged: ["/shoes (device=desktop)"], total: 1 });
    expect((await get("/shoes")).headers.get("x-cache")).toBe("MISS");
    expect((await get("/shoes?page=2")).headers.get("x-cache")).toBe("HIT");
    const query = await worker.fetch(purgeRequest({ paths: ["/shoes?page=2"] }), {}, ctx);
    expect(await query.json()).toEqual({ purged: ["/shoes?page=2 (device=desktop)"], total: 1 });
    expect((await get("/shoes?page=2")).headers.get("x-cache")).toBe("MISS");
  });

  it("every device, navigations and programmatic fetches", async () => {
    const { get, worker, ctx } = setup({ purgeToken: () => "secret" });
    const copies: [string, Parameters<typeof get>[1]][] = [
      ["/shoes", {}],
      ["/shoes", { ua: PHONE_UA }],
      ["/shoes", { ua: TABLET_UA }],
      ["/shoes", { headers: { "sec-fetch-dest": "empty" } }],
      ["/shoes", { ua: PHONE_UA, headers: { "sec-fetch-dest": "empty" } }],
    ];
    for (const [path, init] of copies) await get(path, init);
    const res = await worker.fetch(purgeRequest({ paths: ["/shoes"] }), {}, ctx);
    expect(await res.json()).toEqual({
      purged: [
        "/shoes (device=mobile)",
        "/shoes (device=mobile, fetch)",
        "/shoes (device=tablet)",
        "/shoes (device=desktop)",
        "/shoes (device=desktop, fetch)",
      ],
      total: 5,
    });
    for (const [path, init] of copies) {
      expect((await get(path, init)).headers.get("x-cache")).toBe("MISS");
    }
  });

  it("main's segments field lists the segments to drop", async () => {
    const { get, worker, ctx } = setup({
      purgeToken: () => "secret",
      segment: (r) => ({ region: r.headers.get("x-region") ?? undefined }),
    });
    await get("/shoes", { headers: { "x-region": "south" } });
    const res = await worker.fetch(
      purgeRequest({ paths: ["/shoes"], segments: [{ device: "desktop", region: "south" }] }),
      {},
      ctx,
    );
    expect(await res.json()).toEqual({
      purged: ["/shoes (device=desktop|region=south)"],
      total: 1,
    });
  });

  for (const running of [0, 1, 3]) {
    it(`with ${running} tests at 50% (and tests at 0 and 100), every side is dropped, v7 visitors' stored sides included`, async () => {
      const experiments: Record<string, number> = { off: 0, all: 100 };
      for (let i = 0; i < running; i++) experiments[`t${i}`] = 50;
      const { get, worker, ctx } = setup({
        cms: testCMS(snapshot({ experiments })),
        purgeToken: () => "secret",
      });
      const visitors: Visitor[] = Array.from({ length: 24 }, () => newVisitor());
      // v7 visitors whose stored side differs from the share: out of a test at 100, in one at 0.
      visitors.push({ id: newVisitor().id, active: [], inactiveDrawn: ["all"], pct: { all: 100 } });
      visitors.push({ id: newVisitor().id, active: ["off"], inactiveDrawn: [], pct: { off: 0 } });
      const sides = new Set(visitors.map((v) => JSON.stringify(assign(experiments, v))));
      for (const v of visitors) await get("/shoes", as(v));
      await get("/hats");
      expect(cache.pageKeys()).toHaveLength(sides.size + 1);

      const deletes = vi.spyOn(cache, "delete");
      const res = await worker.fetch(purgeRequest({ paths: ["/shoes"] }), {}, ctx);
      const body = (await res.json()) as { purged: string[]; total: number };
      expect(body.total).toBe(sides.size);
      // Each device × navigation or fetch × every subset of the 2 + running tests.
      expect(deletes).toHaveBeenCalledTimes(3 * 2 * 2 ** (2 + running));
      expect(cache.pageKeys()).toEqual([expect.stringContaining(`${ORIGIN}/hats?`)]);
    });
  }

  it("the campaigns running now and none: copies from before a campaign started are dropped too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const BF = { start: "2026-11-27T00:00:00Z", end: "2026-12-02T00:00:00Z" };
    const { get, worker, ctx } = setup({
      cms: testCMS(snapshot({ campaigns: { "black-friday": BF } })),
      purgeToken: () => "secret",
    });
    vi.setSystemTime(Date.parse(BF.start) - 1_000);
    await get("/shoes");
    vi.setSystemTime(Date.parse(BF.start) + 1_000);
    await get("/shoes");
    expect(cache.pageKeys()).toHaveLength(2);
    const res = await worker.fetch(purgeRequest({ paths: ["/shoes"] }), {}, ctx);
    expect(await res.json()).toEqual({
      purged: ["/shoes (device=desktop, c=black-friday)", "/shoes (device=desktop)"],
      total: 2,
    });
    expect(cache.pageKeys()).toEqual([]);
  });

  it("drops the page's navigation data (its server-function page loads), for that exact path", async () => {
    const { get, worker, ctx } = setup({ purgeToken: () => "secret" }, () =>
      Response.json({ ok: true }),
    );
    const load = (href: string, fn = "abc") =>
      `/_serverFn/${fn}?payload=${encodeURIComponent(JSON.stringify({ data: { href, pathname: href.split("?")[0] } }))}`;
    const paths = [load("/shoes"), load("/shoes", "def"), load("/shoes?page=2"), load("/hats")];
    for (const path of paths) {
      expect((await get(path)).headers.get("x-cache")).toBe("MISS");
      expect((await get(path)).headers.get("x-cache")).toBe("HIT");
    }
    const res = await worker.fetch(purgeRequest({ paths: ["/shoes"] }), {}, ctx);
    expect(await res.json()).toEqual({
      purged: ["/shoes (device=desktop, navigation)", "/shoes (device=desktop, navigation)"],
      total: 2,
    });
    expect((await get(load("/shoes"))).headers.get("x-cache")).toBe("MISS");
    expect((await get(load("/shoes", "def"))).headers.get("x-cache")).toBe("MISS");
    expect((await get(load("/shoes?page=2"))).headers.get("x-cache")).toBe("HIT");
    expect((await get(load("/hats"))).headers.get("x-cache")).toBe("HIT");
  });

  it("the purge's keys are the stored keys byte for byte: devices, segment parts, tests, fetch, navigation data with tracking params and __cseg", async () => {
    const experiments = { t0: 50, t1: 50 };
    const { get, worker, ctx } = setup(
      {
        cms: testCMS(snapshot({ experiments })),
        purgeToken: () => "secret",
        segment: (r) => ({
          salesChannel: r.headers.get("x-sc") ?? undefined,
          regionId: r.headers.get("x-region") ?? undefined,
        }),
      },
      () => Response.json({ ok: true }),
    );
    const load = (href: string, fn: string, query = "") =>
      `/_serverFn/${fn}?payload=${encodeURIComponent(JSON.stringify({ data: { href, pathname: href.split("?")[0] } }))}${query}`;
    const visitors = Array.from({ length: 16 }, () => newVisitor());
    const parts: RequestInit[] = [
      {},
      { headers: { "x-sc": "2" } },
      { headers: { "x-sc": "2", "x-region": "south" } },
    ];
    const urls = [
      "/shoes",
      "/shoes?utm_source=mail&gclid=x",
      load("/shoes", "abc", "&utm_medium=x"),
      load("/shoes?skuId=9", "def", `&${CSEG_PARAM}=stale`),
    ];
    for (const ua of [DESKTOP_UA, PHONE_UA, TABLET_UA]) {
      for (const init of parts) {
        for (const v of visitors.slice(0, 4)) {
          for (const url of urls) {
            const headers = { ...(init.headers as Record<string, string>), ...as(v).headers };
            await get(url, { ua, headers });
            await get(url, { ua, headers: { ...headers, "sec-fetch-dest": "empty" } });
          }
        }
      }
    }
    await get("/hats");
    await get(load("/hats", "abc"));
    const stored = cache.pageKeys().length;
    const res = await worker.fetch(
      purgeRequest({ paths: ["/shoes"], salesChannels: ["2"], regionIds: ["south"] }),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(stored - 2);
    expect(cache.pageKeys().sort()).toEqual([
      expect.stringContaining(`${ORIGIN}/_serverFn/abc?`),
      expect.stringContaining(`${ORIGIN}/hats?`),
    ]);
  });

  it("page loads stored at the same moment both have their shapes kept", async () => {
    const { get, worker, ctx } = setup({ purgeToken: () => "secret" }, () =>
      Response.json({ ok: true }),
    );
    const load = (fn: string) =>
      `/_serverFn/${fn}?payload=${encodeURIComponent(JSON.stringify({ data: { href: "/shoes" } }))}`;
    await Promise.all(["abc", "def", "ghi"].map((fn) => get(load(fn))));
    const res = await worker.fetch(purgeRequest({ paths: ["/shoes"] }), {}, ctx);
    expect(((await res.json()) as { total: number }).total).toBe(3);
    expect(cache.pageKeys()).toEqual([]);
  });

  it("a kept shape the edge cache evicted is kept again on the next page load stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { get, worker, ctx } = setup({ purgeToken: () => "secret" }, () =>
      Response.json({ ok: true }),
    );
    const load = (href: string) =>
      `/_serverFn/abc?payload=${encodeURIComponent(JSON.stringify({ data: { href } }))}`;
    await get(load("/hats"));
    await cache.delete(new Request(`${ORIGIN}/_cache/navigation-shapes`));
    vi.setSystemTime(T0 + 10 * 60_000);
    await get(load("/shoes"));
    const res = await worker.fetch(purgeRequest({ paths: ["/shoes"] }), {}, ctx);
    expect(((await res.json()) as { total: number }).total).toBe(1);
  });

  it("a page's request is one cache lookup: no extra entry is read", async () => {
    const { get } = setup();
    await get("/shoes");
    const match = vi.spyOn(cache, "match");
    expect((await get("/shoes")).headers.get("x-cache")).toBe("HIT");
    expect(match).toHaveBeenCalledTimes(1);
    expect(cache.pageKeys()).toEqual([`${ORIGIN}/shoes?__v=abc123.rev-1&__seg=device%3Ddesktop`]);
  });

  it("a wrong or missing token is a 401; no purgeToken turns it off", async () => {
    const on = setup({ purgeToken: () => "secret" });
    expect(
      (await on.worker.fetch(purgeRequest({ paths: ["/"] }, "Bearer nope"), {}, on.ctx)).status,
    ).toBe(401);
    expect((await on.worker.fetch(purgeRequest({ paths: ["/"] }, ""), {}, on.ctx)).status).toBe(
      401,
    );
    const off = setup();
    expect((await off.worker.fetch(purgeRequest({ paths: ["/"] }), {}, off.ctx)).status).toBe(401);
  });

  it("a body that isn't JSON, or has no paths, is a 400", async () => {
    const { worker, ctx } = setup({ purgeToken: () => "secret" });
    const bad = await worker.fetch(purgeRequest("{not json"), {}, ctx);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("Invalid JSON body");
    for (const body of [{}, { paths: [] }, { paths: ["shoes"] }, null]) {
      const res = await worker.fetch(purgeRequest(body), {}, ctx);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('Body must include "paths": ["/", "/page"]');
    }
  });

  it("without the Cache API, v7's note", async () => {
    const { worker, ctx } = setup({ purgeToken: () => "secret" });
    uninstallCache();
    const res = await worker.fetch(purgeRequest({ paths: ["/"] }), {}, ctx);
    expect(await res.json()).toEqual({ purged: [], total: 0, note: "Cache storage unavailable" });
  });

  it("a failed delete (the Cache API down or its per-request calls spent) is a 503 naming the paths to send again", async () => {
    const { get, worker, ctx } = setup({ purgeToken: () => "secret" });
    await get("/a");
    await get("/b");
    const remove = cache.delete.bind(cache);
    let calls = 0;
    // Each path takes 6 deletes (3 devices × navigation and fetch); the 9th throws, inside /b.
    vi.spyOn(cache, "delete").mockImplementation(async (key: Request) => {
      if (++calls > 8) throw new Error("Too many API requests by single Worker invocation");
      return remove(key);
    });
    const res = await worker.fetch(purgeRequest({ paths: ["/a", "/b", "/c"] }), {}, ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      purged: ["/a (device=desktop)"],
      notPurged: ["/b", "/c"],
      total: 1,
      note: "The Cache API stopped answering: send the notPurged paths again",
    });
    expect((await get("/b")).headers.get("x-cache")).toBe("HIT");
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
