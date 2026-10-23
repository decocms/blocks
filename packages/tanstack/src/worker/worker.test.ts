// @vitest-environment node
/**
 * `createDecoWorker` end to end, with a site's page cache, the CMS and TanStack
 * Start's server entry replaced by test doubles: the header matrix of every
 * always-on behaviour, and each option a site uses.
 */
import { newVisitor, parseVisitor, serializeVisitor } from "@decocms/blocks/experiments";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheVersion,
  createDecoWorker,
  type DecoWorkerOptions,
  isCacheable,
  type PageCache,
  requestVersion,
} from "./index.ts";
import {
  html,
  POINTER,
  recordingEntry,
  recordMetrics,
  removeMetrics,
  snapshot,
  TestContext,
  testCMS,
  testPageCache,
} from "./testing.ts";

const ORIGIN = "https://store.example.com";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";

/** A visitor who has been here before: their cookie, as the worker wrote it. */
const RETURNING = `deco_segment=${serializeVisitor(newVisitor())}`;

afterEach(() => {
  removeMetrics();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(
  options: Partial<DecoWorkerOptions> = {},
  respond?: (request: Request) => Response | Promise<Response>,
) {
  const entry = recordingEntry(respond);
  // A site's own page cache, as the example worker entry wires one (smaller).
  const { store, seen, pageCache } = testPageCache();
  const worker = createDecoWorker({
    serverEntry: entry,
    // Studio lists the test store's host in the release, so a draft link on ORIGIN previews.
    cms: testCMS(snapshot({ previewHosts: ["store.example.com"] })),
    pageCache,
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
  return { worker, entry, ctx, get, store, seen };
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

  it("HTML from a server function is sandboxed and never shared (CVE-2026-102989)", async () => {
    const { get } = setup({}, (request) =>
      new URL(request.url).pathname.startsWith("/_serverFn/")
        ? html("<script>alert(1)</script>", { "CDN-Cache-Control": "public, max-age=60" })
        : html(),
    );
    const forged = await get("/_serverFn/abc?payload=%7B%7D");
    expect(forged.headers.get("content-security-policy")).toBe("sandbox");
    expect(forged.headers.get("cdn-cache-control")).toBe("no-store");
    expect((await get("/")).headers.get("content-security-policy")).toContain("frame-ancestors");
  });

  it("a server function's JSON is left alone", async () => {
    const { get } = setup({}, () => Response.json({ ok: true }));
    const res = await get("/_serverFn/abc?payload=%7B%7D");
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

describe("pageCache: the site's own cache", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("is called for page and server-function GETs of the current release only", async () => {
    const { get, seen } = setup(
      { routes: (r) => (new URL(r.url).pathname === "/api/x" ? new Response("x") : null) },
      (request) =>
        new URL(request.url).pathname.startsWith("/assets/")
          ? new Response("x", { headers: { "content-type": "text/javascript" } })
          : html(),
    );
    await get("/shoes");
    await get(
      `/_serverFn/abc?payload=${encodeURIComponent(JSON.stringify({ data: { href: "/shoes" } }))}`,
    );
    await get("/shoes", { method: "POST", body: "{}" });
    await get("/shoes", { method: "HEAD" });
    await get("/shoes", { headers: { authorization: "Bearer x" } });
    await get(`/shoes?__draft=${encodeURIComponent(POINTER)}`);
    await get(`/shoes?__draft=${SHA}`);
    await get("/_build/client.js");
    await get("/assets/main-AbCdEf123.js");
    await get("/old-shoes");
    await get("/api/x");
    await get("/deco/_liveness");
    expect(seen.map((p) => `${p.request.method} ${p.url.pathname}`)).toEqual([
      "GET /shoes",
      "GET /_serverFn/abc",
    ]);
  });

  it("never in development", async () => {
    const { get, seen } = setup({ dev: true });
    await get("/");
    expect(seen).toHaveLength(0);
  });

  it("gets the visitor the app renders for: on a first visit, the one the cookie names", async () => {
    const { get, seen, entry } = setup();
    const res = await get("/", { firstVisit: true });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("deco_segment="));
    const stored = parseVisitor(cookie?.split(";")[0]?.slice("deco_segment=".length) ?? null);
    expect(seen[0]?.visitor.id).toBe(stored?.id);
    expect(parseVisitor(entry.served[0]?.headers.get("x-deco-visitor") ?? null)?.id).toBe(
      stored?.id,
    );
    expect(seen[0]?.device).toBe("desktop");
    expect((await get("/", { ua: PHONE_UA })) && seen[1]?.device).toBe("mobile");
  });

  it("render() has no visitor cookie; the worker adds it to whatever pageCache answers", async () => {
    let rendered: Response | undefined;
    const pageCache: PageCache = async (page) => {
      rendered = await page.render();
      return new Response("from the site's cache", { headers: { "X-Cache": "HIT" } });
    };
    const { get } = setup({ pageCache });
    const res = await get("/", { firstVisit: true });
    expect(rendered?.headers.has("set-cookie")).toBe(false);
    expect(await res.text()).toBe("from the site's cache");
    expect(res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="))).toHaveLength(1);
  });

  it("render({ csegToken }) is the token the document publishes; render() has none", async () => {
    const tokens: (string | undefined)[] = [];
    const { get, entry } = setup({
      pageCache: async (page) => page.render(tokens.length === 0 ? { csegToken: "a1b2c3d4" } : {}),
    });
    await get("/");
    tokens.push("done");
    await get("/");
    expect(entry.served.map((s) => s.scope?.csegToken)).toEqual(["a1b2c3d4", undefined]);
  });

  it("its answer leaves like any other: security headers, no-store for the CDN unless it names its own", async () => {
    const { get } = setup({
      pageCache: async (page) => {
        const res = await page.render();
        const out = new Response(res.body, res);
        if (page.url.pathname === "/shared")
          out.headers.set("CDN-Cache-Control", "public, max-age=60");
        return out;
      },
    });
    const plain = await get("/");
    expect(plain.headers.get("cdn-cache-control")).toBe("no-store");
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get("/shared")).headers.get("cdn-cache-control")).toBe("public, max-age=60");
  });

  it("a page request with Authorization never reaches it and answers private, whatever the app said", async () => {
    const { get, seen } = setup({}, () =>
      html("x", { "cache-control": "public, max-age=120, s-maxage=900" }),
    );
    const res = await get("/shoes", { headers: { authorization: "Bearer x" } });
    expect(seen).toHaveLength(0);
    expect(res.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    const plain = await get("/shoes");
    expect(plain.headers.get("cache-control")).not.toContain("private");
  });

  it("without one, nothing is cached: every request renders, headers as the app sent them", async () => {
    const { get, entry } = setup({ pageCache: undefined }, () =>
      html("x", { "cache-control": "public, max-age=60" }),
    );
    const a = await get("/");
    await get("/");
    expect(entry.served).toHaveLength(2);
    expect(a.headers.get("cache-control")).toBe("public, max-age=60");
    expect(a.headers.has("x-cache")).toBe(false);
  });
});

describe("the helpers a site's cache uses", () => {
  it("isCacheable: a GET of the current release, outside dev, without Authorization, not /_build", () => {
    const req = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);
    expect(isCacheable(req("/"), { version: null })).toBe(true);
    expect(isCacheable(req("/"), { version: POINTER })).toBe(false);
    expect(isCacheable(req("/"), { version: null, dev: true })).toBe(false);
    expect(isCacheable(req("/", { method: "POST" }), { version: null })).toBe(false);
    expect(isCacheable(req("/", { headers: { authorization: "x" } }), { version: null })).toBe(
      false,
    );
    expect(isCacheable(req("/_build/x.js"), { version: null })).toBe(false);
  });

  it("cacheVersion is <build>.<revision>, the build alone when the content doesn't load", async () => {
    expect(await cacheVersion(testCMS(snapshot({ revision: "rev-9" })), "abc123")).toBe(
      "abc123.rev-9",
    );
    const broken = {
      forRelease: () => ({ revision: () => Promise.reject(new Error("down")) }),
    } as unknown as Parameters<typeof cacheVersion>[0];
    expect(await cacheVersion(broken, "abc123")).toBe("abc123");
  });

  it("requestVersion reads the version the worker checked, on the request routes and pageCache get", async () => {
    let seen: string | null | undefined;
    const { get } = setup({
      routes: (request) => {
        seen = requestVersion(request);
        return null;
      },
    });
    await get(`/?__draft=${encodeURIComponent(POINTER)}`);
    expect(seen).toBe(POINTER);
    await get("/", { headers: { "x-deco-version": POINTER } });
    expect(seen).toBe(null);
  });
});

describe("drafts", () => {
  const draftUrl = `/?__draft=${encodeURIComponent(POINTER)}`;

  it("a draft link renders the draft: header to the app, cookie stored, never cached, noindex", async () => {
    const { get, entry, seen } = setup();
    await get("/"); // a cached release copy exists
    const res = await get(draftUrl);
    expect(entry.served.at(-1)?.headers.get("x-deco-version")).toBe(POINTER);
    expect(entry.served.at(-1)?.scope?.draft).toBe(POINTER);
    expect(res.headers.has("x-cache")).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("set-cookie")).toBe(
      `__deco_draft=${encodeURIComponent(POINTER)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
    // The site's page cache saw the release request only, never the draft.
    expect(seen.map((p) => p.url.search)).toEqual([""]);
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
    expect(entry.served[0]?.headers.get("x-deco-version")).toBe(POINTER);
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
    expect(entry.served[0]?.headers.has("x-deco-version")).toBe(false);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("a pointer that doesn't parse is no draft: the release, cached as usual", async () => {
    const { get, entry, seen } = setup();
    const res = await get("/?__draft=junk");
    expect(entry.served[0]?.headers.has("x-deco-version")).toBe(false);
    expect(seen).toHaveLength(1);
    expect(res.headers.has("x-robots-tag")).toBe(false);
  });

  it("an x-deco-version header from outside never counts", async () => {
    const { get, entry, seen } = setup();
    await get("/", { headers: { "x-deco-version": POINTER } });
    expect(entry.served[0]?.headers.has("x-deco-version")).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("a draft request's server function never reaches the site's cache either", async () => {
    const { get, seen } = setup({}, () => Response.json({}));
    const payload = encodeURIComponent(JSON.stringify({ data: { href: "/shoes" } }));
    const res = await get(`/_serverFn/abc?payload=${payload}`, {
      headers: { cookie: `__deco_draft=${encodeURIComponent(POINTER)}` },
    });
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(seen).toHaveLength(0);
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

  it("a new visitor served from the site's cache still gets their cookie; the stored copy has none", async () => {
    const { get, entry, store } = setup();
    await get("/", { firstVisit: true });
    const hit = await get("/", { firstVisit: true });
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(entry.served).toHaveLength(1);
    expect(segmentCookies(hit)).toHaveLength(1);
    expect(store.entries.size).toBe(1);
    for (const stored of store.entries.values())
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

  it("decides each test and campaign once, hands them to the app on x-deco-assignments and to pageCache; a forged copy never counts", async () => {
    const cms = testCMS(
      snapshot({
        experiments: { all: 100, none: 0 },
        campaigns: { sale: {}, later: { start: "2999-01-01T00:00Z" } },
      }),
    );
    let assignments: unknown;
    const { get, entry } = setup({
      cms,
      pageCache: async (page) => {
        assignments = page.assignments;
        return page.render();
      },
    });
    await get("/", { headers: { "x-deco-assignments": "x=+none" } });
    expect(entry.served[0]?.headers.get("x-deco-assignments")).toBe("x=+all,-none|c=-later,+sale");
    expect(assignments).toEqual({
      version: null,
      experiments: { all: true, none: false },
      campaigns: { later: false, sale: true },
    });
    const routed = setup({
      cms,
      routes: (request) => html(request.headers.get("x-deco-assignments") ?? "none"),
    });
    expect(
      await (await routed.get("/hats", { headers: { "x-deco-assignments": "x=+none" } })).text(),
    ).toBe("none");
  });

  it("a preview link's switched tests are decided in the worker, even a test at 0%", async () => {
    const cms = testCMS(
      snapshot({ previewHosts: ["store.example.com"], experiments: { none: 0 } }),
    );
    const { get, entry } = setup({ cms });
    // `local` names no draft (`deco serve`'s working tree): the release, nothing fetched.
    const local = "127.0.0.1:1/p@local";
    const link = local.replace("@", `?__test=${encodeURIComponent("none=on")}@`);
    await get(`/?__draft=${encodeURIComponent(link)}`);
    expect(entry.served[0]?.headers.get("x-deco-version")).toBe(local);
    expect(entry.served[0]?.headers.get("x-deco-assignments")).toBe("x=+none");
  });

  it("a preview (a draft) gets the visitor but never writes deco_segment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ set: {}, delete: [] })),
    );
    const { get, entry } = setup();
    const res = await get(`/?__draft=${encodeURIComponent(POINTER)}`, { firstVisit: true });
    expect(entry.served[0]?.headers.get("x-deco-version")).toBe(POINTER);
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
    expect(entry.served[0]?.headers.get("x-deco-version")).toBe(SHA);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`__deco_draft=${SHA};`))).toBe(true);
    expect(segmentCookies(res)).toEqual([]);
  });

  it("with the preview time and switched tests on it: the version alone on x-deco-version, the rest decided", async () => {
    const value = `${SHA}?__at=${encodeURIComponent("2026-11-28T10:00:00-03:00")}&__test=${encodeURIComponent("hero=on")}`;
    const { get, entry } = setup();
    const res = await get(`/?__draft=${encodeURIComponent(value)}`);
    expect(entry.served[0]?.headers.get("x-deco-version")).toBe(SHA);
    expect(entry.served[0]?.headers.has("x-deco-assignments")).toBe(true);
    // The cookie keeps the whole link, so the next request previews the same.
    expect(
      res.headers
        .getSetCookie()
        .some((c) => c.startsWith(`__deco_draft=${encodeURIComponent(value)};`)),
    ).toBe(true);
  });

  it("a preview time typed by hand, unencoded, reads as @decocms/blocks reads it", async () => {
    const { get, entry } = setup();
    const res = await get(`/?__draft=${SHA}?__at=2026-11-28T10:00:00-03:00`, { firstVisit: true });
    expect(entry.served[0]?.headers.get("x-deco-version")).toBe(SHA);
    expect(segmentCookies(res)).toEqual([]);
  });

  it("on a host that may not preview, or when it doesn't parse, the request gets the current release", async () => {
    const { get, entry } = setup();
    await get(`https://elsewhere.example.com/?__draft=${SHA}`);
    await get(`/?__draft=${SHA.slice(1)}`);
    await get(`/?__draft=${encodeURIComponent(`${SHA}?__at=yesterday`)}`);
    await get(`/?__draft=${encodeURIComponent(`${SHA}?page=2`)}`);
    for (const served of entry.served) expect(served.headers.has("x-deco-version")).toBe(false);
  });
});

describe("the draft hosts: the release's, as the CMS reads them", () => {
  const link = (host: string) => `https://${host}/?__draft=${encodeURIComponent(POINTER)}`;

  async function previews(options: Partial<DecoWorkerOptions>, host: string): Promise<boolean> {
    const { get, entry } = setup(options);
    const res = await get(link(host));
    const rendered = entry.served[0]?.headers.get("x-deco-version") === POINTER;
    // The cookie and the headers agree with what the app rendered.
    expect(res.headers.has("set-cookie"), host).toBe(rendered);
    expect(res.headers.get("x-robots-tag") === "noindex, nofollow", host).toBe(rendered);
    return rendered;
  }

  it("with no list in the release (no site published one), every host previews; an empty list, none", async () => {
    const open = testCMS(snapshot());
    expect((await open.settings()).preview.hosts).toEqual(["*"]);
    for (const host of ["store.example.com", "localhost:5173", "acme.deco.site"]) {
      expect(await previews({ cms: open }, host), host).toBe(true);
    }
    const closed = testCMS(snapshot({ previewHosts: [] }));
    expect((await closed.settings()).preview.hosts).toEqual([]);
    for (const host of ["store.example.com", "localhost:5173", "acme.deco.site"]) {
      expect(await previews({ cms: closed }, host), host).toBe(false);
    }
  });

  it('a release whose hosts are "*" previews on every host', async () => {
    const cms = testCMS(snapshot({ previewHosts: ["*"] }));
    for (const host of ["store.example.com", "localhost:5173", "acme.deco.site"]) {
      expect(await previews({ cms }, host), host).toBe(true);
    }
  });

  it("the release's preview hosts: only those, wildcards as the CMS matches them", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.store.example.com", "*.deco.site"] }));
    for (const host of ["staging.store.example.com", "acme.deco.site", "acme.deco.site:8443"]) {
      expect(await previews({ cms }, host), host).toBe(true);
    }
    for (const host of [
      "store.example.com",
      "deco.site",
      "acme.deco.site.attacker.example",
      "acme.deco-cx.workers.dev",
    ]) {
      expect(await previews({ cms }, host), host).toBe(false);
    }
  });

  it("a refused host still ends a preview (?__draft=off expires the cookie anywhere)", async () => {
    const { get } = setup({ cms: testCMS(snapshot()) });
    expect((await get("/?__draft=off")).headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("a refused draft request is the release, and may be cached", async () => {
    const { get, entry, seen } = setup({ cms: testCMS(snapshot({ previewHosts: [] })) });
    await get(`/?__draft=${encodeURIComponent(POINTER)}`);
    expect(seen).toHaveLength(1);
    expect(entry.served.every((s) => !s.headers.has("x-deco-version"))).toBe(true);
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
        seen = request.headers.get("x-deco-version");
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
    const { get, store } = setup({}, () => html("not found", { "x-page-status": "404" }));
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.has("x-page-status")).toBe(false);
    expect(store.entries.size).toBe(0);
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

  it("the site's cache decides the label: its X-Cache, a stale copy counting as a HIT", async () => {
    const points = recordMetrics();
    const answers = ["MISS", "HIT", "STALE-HIT", "STALE-ERROR", "SOMETHING"];
    const pageCache: PageCache = async (page) => {
      const response = await page.render();
      const out = new Response(response.body, response);
      out.headers.set("X-Cache", answers[points.length] as string);
      return out;
    };
    const { get } = setup({ pageCache });
    for (const _ of answers) await get("/");
    expect(points.map((p) => p.labels.cache)).toEqual(["MISS", "HIT", "HIT", "HIT", "BYPASS"]);
  });

  it("without a pageCache every page is BYPASS", async () => {
    const points = recordMetrics();
    const { get } = setup({ pageCache: undefined });
    await get("/");
    expect(points.map((p) => p.labels.cache)).toEqual(["BYPASS"]);
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
        cache: "MISS",
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

  it("an upstream's X-Cache never counts: only the site's pageCache decides", async () => {
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
