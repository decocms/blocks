// @vitest-environment node
import { assign, newVisitor, parseVisitor, serializeVisitor } from "@decocms/blocks/experiments";
import { NextRequest, NextResponse } from "next/server.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GONE_POINTER, POINTER, serveDrafts, snapshot, testCMS } from "../__tests__/fixtures.ts";
import {
  ASSIGNMENTS_ROUTE_PREFIX,
  applyDraft,
  applyVisitor,
  assignmentsKey,
  assignmentsRoutePath,
  assignmentsSegment,
  DRAFT_ROUTE_PREFIX,
  decideAssignments,
  decideDraft,
  decideVisitor,
  draftProxy,
  draftRequestHeaders,
  isAssignmentsRoutePath,
  isDraftRoutePath,
  parseAssignmentsSegment,
  readAssignments,
  rewriteToAssignmentsRoute,
  rewriteToDraftRoute,
  visitorRequestHeaders,
} from "./index.ts";

const draftLink = (path = "/shoes", host = "shop.example.com") =>
  new NextRequest(
    `https://${host}${path}${path.includes("?") ? "&" : "?"}__draft=${encodeURIComponent(POINTER)}`,
  );
const withCookie = (path = "/shoes", extra: Record<string, string> = {}) =>
  new NextRequest(`https://shop.example.com${path}`, {
    headers: { cookie: `__deco_draft=${encodeURIComponent(POINTER)}`, ...extra },
  });

/** The request headers NextResponse.next/rewrite forwards (`x-middleware-request-*`). */
function forwarded(response: Response, name: string): string | null {
  const overridden = response.headers.get("x-middleware-override-headers")?.split(",") ?? [];
  return overridden.includes(name) ? response.headers.get(`x-middleware-request-${name}`) : null;
}

beforeEach(() => serveDrafts());
afterEach(() => vi.unstubAllGlobals());

const EXACT = "max-age=0, no-cache, must-revalidate";

describe("decideDraft", () => {
  it("a draft link: the pointer, and the cookie that keeps the preview going", async () => {
    const d = await decideDraft(testCMS(), draftLink());
    expect(d.version?.version ?? null).toBe(POINTER);
    expect(d.setCookie).toBe(await testCMS().draftCookie(draftLink()));
  });

  it("the cookie alone: the pointer, no new cookie", async () => {
    expect(await decideDraft(testCMS(), withCookie())).toEqual({
      version: { version: POINTER },
      setCookie: null,
      preview: true,
      releaseCheck: expect.any(String),
    });
  });

  it("no draft signal never asks the CMS", async () => {
    const real = testCMS();
    const cms = {
      readVersion: vi.fn(async () => ({ version: POINTER })),
      forRelease: vi.fn(() => real.forRelease()),
      forDraft: vi.fn((pointer: string) => real.forDraft(pointer)),
      checkRelease: vi.fn(() => real.checkRelease()),
    };
    expect(await decideDraft(cms, new NextRequest("https://shop.example.com/shoes?q="))).toEqual({
      version: null,
      setCookie: null,
    });
    expect(cms.readVersion).not.toHaveBeenCalled();
    expect(cms.forRelease).not.toHaveBeenCalled();
    expect(cms.forDraft).not.toHaveBeenCalled();
    expect(cms.checkRelease).not.toHaveBeenCalled();
  });

  it("?__draft=off ends the preview on any host, one that may not preview included", async () => {
    const off = new NextRequest("https://shop.example.com/?__draft=off");
    const d = await decideDraft(testCMS(snapshot()), off);
    expect(d.version?.version ?? null).toBe(null);
    expect(d.setCookie).toContain("Max-Age=0");
  });

  it("a host outside the allowlist gets the release", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.shop.example.com"] }));
    expect(await decideDraft(cms, draftLink())).toEqual({
      version: null,
      setCookie: null,
      preview: true,
    });
    expect(await decideDraft(cms, draftLink("/", "acme.deco.site"))).toEqual({
      version: null,
      setCookie: null,
      preview: true,
    });
    expect(
      (await decideDraft(cms, draftLink("/", "staging.shop.example.com"))).version?.version ?? null,
    ).toBe(POINTER);
  });

  it("judges the host the visitor asked for (x-forwarded-host), not the origin's", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["shop.example.com"] }));
    const behindProxy = new NextRequest(
      `https://origin.internal/?__draft=${encodeURIComponent(POINTER)}`,
      { headers: { "x-forwarded-host": "shop.example.com" } },
    );
    expect((await decideDraft(cms, behindProxy)).version?.version ?? null).toBe(POINTER);
    const direct = new NextRequest(
      `https://origin.internal/?__draft=${encodeURIComponent(POINTER)}`,
    );
    expect((await decideDraft(cms, direct)).version?.version ?? null).toBe(null);
  });

  it("a pointer that doesn't parse is no draft and stores no cookie", async () => {
    expect(
      await decideDraft(testCMS(), new NextRequest("https://shop.example.com/?__draft=junk")),
    ).toEqual({
      version: null,
      setCookie: null,
      preview: true,
    });
  });

  it("a pointer to a deleted draft: the release, the cookie expired, unavailable (no error)", async () => {
    const gone = new NextRequest(
      `https://shop.example.com/shoes?__draft=${encodeURIComponent(GONE_POINTER)}`,
    );
    const d = await decideDraft(testCMS(), gone);
    expect(d.version).toBe(null);
    expect(d.preview).toBe(true);
    expect(d.unavailable).toBe(true);
    expect(d.setCookie).toContain("Max-Age=0");
    const viaCookie = new NextRequest("https://shop.example.com/shoes", {
      headers: { cookie: `__deco_draft=${encodeURIComponent(GONE_POINTER)}` },
    });
    expect((await decideDraft(testCMS(), viaCookie)).unavailable).toBe(true);
  });

  it("a draft whose host fails (not gone): the release, unavailable, the cookie kept", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    const d = await decideDraft(testCMS(), withCookie());
    expect(d.version).toBe(null);
    expect(d.unavailable).toBe(true);
    expect(d.setCookie).toBe(null);
  });
});

describe("the request the proxy forwards", () => {
  it("carries the accepted version on x-deco-version", () => {
    const h = draftRequestHeaders(withCookie(), { version: { version: POINTER }, setCookie: null });
    expect(h.get("x-deco-version")).toBe(POINTER);
  });

  it("never carries a forged x-deco-version", async () => {
    const forged = new NextRequest("https://shop.example.com/", {
      headers: { "x-deco-version": POINTER },
    });
    const d = await decideDraft(testCMS(), forged);
    expect(draftRequestHeaders(forged, d).has("x-deco-version")).toBe(false);
  });
});

describe("rewriteToDraftRoute", () => {
  it("rewrites a drafted request onto /_draft, keeping the path and query", () => {
    const res = rewriteToDraftRoute(draftLink("/shoes?sort=price"), {
      version: { version: POINTER },
      setCookie: null,
    });
    const target = new URL(res?.headers.get("x-middleware-rewrite") ?? "");
    expect(target.pathname).toBe(`${DRAFT_ROUTE_PREFIX}/shoes`);
    expect(target.searchParams.get("sort")).toBe("price");
    expect(forwarded(res!, "x-deco-version")).toBe(POINTER);
  });

  it("leaves the release and the draft route itself alone", () => {
    expect(rewriteToDraftRoute(draftLink(), { version: null, setCookie: null })).toBe(null);
    expect(
      rewriteToDraftRoute(draftLink("/_draft/shoes"), {
        version: { version: POINTER },
        setCookie: null,
      }),
    ).toBe(null);
    expect(isDraftRoutePath("/_draft")).toBe(true);
    expect(isDraftRoutePath("/_drafts")).toBe(false);
  });
});

describe("applyDraft", () => {
  it("a draft: the cookie, never stored, never indexed", () => {
    const res = applyDraft(NextResponse.next(), {
      version: { version: POINTER },
      setCookie: "__deco_draft=x; Path=/",
    });
    expect(res.headers.get("set-cookie")).toBe("__deco_draft=x; Path=/");
    expect(res.headers.get("cache-control")).toBe(EXACT);
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("any draft signal (off, a refused host, an unavailable draft): the exact headers", () => {
    const res = applyDraft(NextResponse.next(), { version: null, setCookie: null, preview: true });
    expect(res.headers.get("cache-control")).toBe(EXACT);
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("the release: nothing, except a cookie that ends a preview; the site's own cookies stay", () => {
    const res = NextResponse.next();
    res.headers.append("set-cookie", "a=1; Path=/");
    applyDraft(res, { version: null, setCookie: "__deco_draft=; Path=/; Max-Age=0" });
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "__deco_draft=; Path=/; Max-Age=0"]);
    expect(res.headers.has("x-robots-tag")).toBe(false);
    expect(res.headers.has("cache-control")).toBe(false);
  });
});

describe("draftProxy", () => {
  it("drafted: rewritten, forwarded, cookie and headers", async () => {
    const res = await draftProxy(testCMS())(draftLink());
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/_draft/shoes");
    expect(res.headers.get("set-cookie")).toContain("__deco_draft=");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("off goes to the draft route, never the assignments route, and answers max-age=0, no-cache, must-revalidate", async () => {
    const cms = testCMS(
      snapshot({ previewHosts: ["shop.example.com"], experiments: { hero: 100 } }),
    );
    const res = await draftProxy(cms, { assignments: () => true })(
      new NextRequest("https://shop.example.com/shoes?__draft=off"),
    );
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/_draft/shoes");
    expect(forwarded(res, "x-deco-version")).toBe(null);
    expect(res.headers.get("cache-control")).toBe(EXACT);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("a request with only the draft cookie never goes to the assignments route", async () => {
    const cms = testCMS(
      snapshot({ previewHosts: ["shop.example.com"], experiments: { hero: 100 } }),
    );
    for (const cookie of [`__deco_draft=${encodeURIComponent(POINTER)}`, "__deco_draft=junk"]) {
      const res = await draftProxy(cms, { assignments: () => true })(
        new NextRequest("https://shop.example.com/shoes", { headers: { cookie } }),
      );
      expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname, cookie).toBe(
        "/_draft/shoes",
      );
      expect(res.headers.get("cache-control"), cookie).toBe(EXACT);
    }
  });

  it("a deleted draft: the draft route renders the release with the notice, the cookie expired", async () => {
    const res = await draftProxy(testCMS())(
      new NextRequest(
        `https://shop.example.com/shoes?__draft=${encodeURIComponent(GONE_POINTER)}`,
        {
          headers: { "x-deco-draft-unavailable": "0" },
        },
      ),
    );
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/_draft/shoes");
    expect(forwarded(res, "x-deco-version")).toBe(null);
    expect(forwarded(res, "x-deco-draft-unavailable")).toBe("1");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(res.headers.get("cache-control")).toBe(EXACT);
  });

  it("a forged x-deco-draft-unavailable never reaches the pages", async () => {
    const res = await draftProxy(testCMS())(
      new NextRequest("https://shop.example.com/", {
        headers: { "x-deco-draft-unavailable": "1" },
      }),
    );
    expect(forwarded(res, "x-deco-draft-unavailable")).toBe(null);
  });

  it("rewrite: false keeps the route and still forwards the pointer", async () => {
    const res = await draftProxy(testCMS(), { rewrite: () => false })(withCookie());
    expect(res.headers.has("x-middleware-rewrite")).toBe(false);
    expect(forwarded(res, "x-deco-version")).toBe(POINTER);
  });

  it("forwards what it decided on x-deco-assignments, never a forged copy", async () => {
    const cms = testCMS(snapshot({ experiments: { hero: 100, dark: 0 } }));
    const res = await draftProxy(cms)(
      new NextRequest("https://shop.example.com/", {
        headers: {
          "x-deco-assignments": assignmentsSegment({ experiments: { dark: true }, campaigns: {} }),
        },
      }),
    );
    expect(parseAssignmentsSegment(forwarded(res, "x-deco-assignments") ?? "")).toEqual({
      experiments: { dark: false, hero: true },
      campaigns: {},
    });
  });

  it("the release passes through, a forged header removed", async () => {
    const res = await draftProxy(testCMS())(
      new NextRequest("https://shop.example.com/", { headers: { "x-deco-version": POINTER } }),
    );
    expect(res.headers.has("x-middleware-rewrite")).toBe(false);
    expect(forwarded(res, "x-deco-version")).toBe(null);
    expect(res.headers.has("x-robots-tag")).toBe(false);
  });
});

describe("the visitor", () => {
  const release = { version: null, setCookie: null };
  const preview = { version: { version: POINTER }, setCookie: null };
  const visit = (headers: Record<string, string> = {}, url = "https://shop.example.com/shoes") =>
    new NextRequest(url, { headers });
  const segmentCookies = (res: Response) =>
    res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));
  const nameValue = (setCookie: string) => setCookie.split(";")[0] as string;

  it("a first visit: a new visitor and the deco_segment cookie", () => {
    const d = decideVisitor(visit(), release);
    expect(d.visitor.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(d.setCookie).toMatch(
      /^deco_segment=[^;]+; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/,
    );
    expect(nameValue(d.setCookie as string)).toBe(`deco_segment=${serializeVisitor(d.visitor)}`);
  });

  it("a returning visitor keeps their id; no cookie", () => {
    const first = decideVisitor(visit(), release);
    const again = decideVisitor(visit({ cookie: nameValue(first.setCookie as string) }), release);
    expect(again.visitor.id).toBe(first.visitor.id);
    expect(again.setCookie).toBe(null);
    expect(segmentCookies(applyVisitor(NextResponse.next(), again))).toEqual([]);
  });

  it("a preview never writes the visitor's cookie", () => {
    const d = decideVisitor(visit(), preview);
    expect(d.visitor.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(d.setCookie).toBe(null);
  });

  it("http (local development) gets a cookie without Secure; x-forwarded-proto wins", () => {
    const local = decideVisitor(visit({}, "http://localhost:3000/"), release);
    expect(local.setCookie).not.toContain("Secure");
    const behind = visit({ "x-forwarded-proto": "https" }, "http://localhost:3000/");
    expect(decideVisitor(behind, release).setCookie).toContain("Secure");
  });

  it("forwards it on x-deco-visitor; a forged copy is always removed", () => {
    const forged = visit({ "x-deco-visitor": "forged" });
    expect(draftRequestHeaders(forged, release).has("x-deco-visitor")).toBe(false);
    const d = decideVisitor(forged, release);
    const headers = visitorRequestHeaders(draftRequestHeaders(forged, release), d);
    expect(parseVisitor(headers.get("x-deco-visitor"))?.id).toBe(d.visitor.id);
  });

  it("draftProxy: forwards the visitor and sets the cookie once", async () => {
    const proxy = draftProxy(testCMS());
    const res = await proxy(visit({ "x-deco-visitor": "forged" }));
    const visitor = parseVisitor(forwarded(res, "x-deco-visitor"));
    expect(visitor).not.toBe(null);
    const [cookie, ...more] = segmentCookies(res);
    expect(more).toEqual([]);
    const again = await proxy(visit({ cookie: nameValue(cookie as string) }));
    expect(segmentCookies(again)).toEqual([]);
    expect(parseVisitor(forwarded(again, "x-deco-visitor"))?.id).toBe(visitor?.id);
  });

  it("draftProxy: a draft link forwards the visitor to the draft route, without the cookie", async () => {
    const res = await draftProxy(testCMS(snapshot({ previewHosts: ["shop.example.com"] })))(
      draftLink(),
    );
    expect(forwarded(res, "x-deco-version")).toBe(POINTER);
    expect(parseVisitor(forwarded(res, "x-deco-visitor"))).not.toBe(null);
    expect(segmentCookies(res)).toEqual([]);
  });
});

describe("the version: an old release from a Studio link", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const link = (value: string, host = "shop.example.com") =>
    new NextRequest(`https://${host}/shoes?__draft=${encodeURIComponent(value)}`);
  const cms = () => testCMS(snapshot({ previewHosts: ["shop.example.com"] }));

  it("a release SHA is the version forwarded; the preview's parameters are its date, tests and campaigns", async () => {
    const plain = await decideDraft(cms(), link(SHA));
    expect(plain.version).toEqual({ version: SHA });
    expect(plain.setCookie).toContain(`__deco_draft=${SHA};`);
    const at = encodeURIComponent("2026-11-28T10:00:00-03:00");
    const value = `${SHA}?__at=${at}&__test=${encodeURIComponent("hero=off")}&__campaign=${encodeURIComponent("bf=on")}`;
    const d = await decideDraft(cms(), link(value));
    expect(d.version?.version).toBe(SHA);
    expect(d.version?.date?.toISOString()).toBe("2026-11-28T13:00:00.000Z");
    expect({ ...d.version?.experiments }).toEqual({ hero: false });
    expect({ ...d.version?.campaigns }).toEqual({ bf: true });
    // The cookie keeps the whole link, so the next request previews the same.
    expect(d.setCookie).toContain(`__deco_draft=${encodeURIComponent(value)};`);
    const res = await draftProxy(cms())(link(value));
    expect(forwarded(res, "x-deco-version")).toBe(SHA);
  });

  it("a preview time typed by hand, unencoded, reads as @decocms/blocks reads it", async () => {
    const typed = new NextRequest(
      `https://shop.example.com/shoes?__draft=${SHA}?__at=2026-11-28T10:00:00-03:00`,
    );
    const d = await decideDraft(cms(), typed);
    expect(d.version?.version).toBe(SHA);
    expect(d.version?.date?.toISOString()).toBe("2026-11-28T13:00:00.000Z");
  });

  it("on a host that may not preview, or when it doesn't parse: the current release", async () => {
    expect(
      (await decideDraft(cms(), link(SHA, "elsewhere.example.com"))).version?.version ?? null,
    ).toBe(null);
    expect((await decideDraft(cms(), link(SHA.slice(1)))).version?.version ?? null).toBe(null);
    expect((await decideDraft(cms(), link(`${SHA}?__at=yesterday`))).version?.version ?? null).toBe(
      null,
    );
    expect((await decideDraft(cms(), link(`${SHA}?page=2`))).version?.version ?? null).toBe(null);
  });
});

describe("readAssignments and assignmentsKey: what a site's own cache keys on", () => {
  const BF = { start: "2026-11-27T00:00:00Z", end: "2026-12-01T23:59:59Z" };
  const content = snapshot({ experiments: { hero: 50 }, campaigns: { "black-friday": BF } });
  const visitorIn = (inside: boolean) => {
    for (;;) {
      const v = newVisitor();
      if (assign({ hero: 50 }, v).hero === inside) return v;
    }
  };

  it("sides of a test key apart, the same side alike, never by the visitor id", async () => {
    const cms = testCMS(content);
    const key = async (visitor: ReturnType<typeof newVisitor>) =>
      assignmentsKey(await readAssignments(cms, { visitor, version: null }));
    const a = visitorIn(true);
    const keys = [await key(a), await key(visitorIn(true)), await key(visitorIn(false))];
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).not.toContain(a.id);
  });

  it("a campaign starting changes the key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const cms = testCMS(content);
      vi.setSystemTime(Date.parse(BF.start) - 1_000);
      const before = assignmentsKey(await readAssignments(cms, { visitor: null, version: null }));
      vi.setSystemTime(Date.parse(BF.start) + 1_000);
      const after = assignmentsKey(await readAssignments(cms, { visitor: null, version: null }));
      expect(before).toBe("");
      expect(after).toBe("c=black-friday");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a version keys apart from the release and from another version", () => {
    const none = { experiments: {}, campaigns: {} };
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const keys = [null, POINTER, sha].map((version) => assignmentsKey({ version, ...none }));
    expect(new Set(keys).size).toBe(3);
  });

  it("a preview's moment and switched tests and campaigns decide, over the visitor and now", async () => {
    const cms = testCMS(content);
    const read = await readAssignments(cms, {
      visitor: visitorIn(false),
      date: new Date(Date.parse(BF.start) + 1_000),
      experiments: { hero: true },
    });
    expect(read).toEqual({
      version: null,
      experiments: { hero: true },
      campaigns: { "black-friday": true },
    });
    const off = await readAssignments(cms, {
      visitor: visitorIn(true),
      date: new Date(Date.parse(BF.start) + 1_000),
      experiments: { hero: false },
      campaigns: { "black-friday": false },
    });
    expect(assignmentsKey(off)).toBe("");
  });

  it("decideAssignments decides from the draft decision and the visitor, once", async () => {
    const cms = testCMS(
      snapshot({ previewHosts: ["shop.example.com"], experiments: { hero: 50, dark: 0 } }),
    );
    // `local` names no draft (deco serve's working tree): the release, nothing fetched.
    const local = "127.0.0.1:1/p@local";
    const at = encodeURIComponent("2026-11-28T10:00:00Z");
    const pointer = local.replace("@", `?__at=${at}&__test=${encodeURIComponent("dark=on")}@`);
    const req = new NextRequest(`https://shop.example.com/?__draft=${encodeURIComponent(pointer)}`);
    const draft = await decideDraft(cms, req);
    expect(draft.version?.version).toBe(local);
    const visitor = decideVisitor(req, draft);
    const decided = await decideAssignments(cms, draft, visitor);
    expect(decided.version).toBe(local);
    expect(decided.experiments.dark).toBe(true); // a preview may switch on a test at 0%
    expect(decided.experiments.hero).toBe(assign({ hero: 50 }, visitor.visitor).hero);
  });

  it("no experiments or campaigns: no assignments", async () => {
    const assignments = await readAssignments(testCMS(), { visitor: newVisitor(), version: null });
    expect(assignmentsKey(assignments)).toBe("");
  });
});

describe("the assignments route: Next's path-keyed cache keys on the request's assignments", () => {
  const BF = { start: "2026-11-27T00:00:00Z", end: "2026-12-01T23:59:59Z" };
  const content = snapshot({
    experiments: { hero: 50, later: 0 },
    campaigns: { "black-friday": BF },
  });
  const visitorIn = (inside: boolean) => {
    for (;;) {
      const v = newVisitor();
      if (assign({ hero: 50 }, v).hero === inside) return v;
    }
  };
  const asCookie = (visitor: ReturnType<typeof newVisitor>) => ({
    cookie: `deco_segment=${serializeVisitor(visitor)}`,
  });
  /** The path the request is rewritten to, or null when it isn't. */
  async function routed(
    cms: ReturnType<typeof testCMS>,
    request: NextRequest,
  ): Promise<string | null> {
    const draft = await decideDraft(cms, request);
    const res = await rewriteToAssignmentsRoute(cms, request, draft, decideVisitor(request, draft));
    const target = res?.headers.get("x-middleware-rewrite");
    return target ? new URL(target).pathname + new URL(target).search : null;
  }
  const page = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`https://shop.example.com${path}`, { headers });

  it("two visitors on opposite sides of a test get different paths; the same side, the same path", async () => {
    const cms = testCMS(content);
    const a = visitorIn(true);
    const paths = [
      await routed(cms, page("/shoes?color=red", asCookie(a))),
      await routed(cms, page("/shoes?color=red", asCookie(visitorIn(true)))),
      await routed(cms, page("/shoes?color=red", asCookie(visitorIn(false)))),
    ];
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0]).not.toBe(paths[2]);
    expect(paths[0]).toMatch(/^\/_assignments\/[A-Za-z0-9_-]+\/shoes\?color=red$/);
    expect(paths[2]).toMatch(/^\/_assignments\/[A-Za-z0-9_-]+\/shoes\?color=red$/);
    expect(parseAssignmentsSegment(paths[2]!.split("/")[2]!)).toEqual({
      experiments: { hero: false, later: false },
      campaigns: { "black-friday": false },
    });
    expect(paths.join()).not.toContain(a.id);
  });

  it("the page gets neither the visitor nor a draft header", async () => {
    const cms = testCMS(content);
    const req = page("/shoes", {
      ...asCookie(visitorIn(true)),
      "x-deco-visitor": "forged",
      "x-deco-version": POINTER,
    });
    const draft = await decideDraft(cms, req);
    const res = await rewriteToAssignmentsRoute(cms, req, draft, decideVisitor(req, draft));
    expect(forwarded(res!, "x-deco-visitor")).toBeNull();
    expect(forwarded(res!, "x-deco-version")).toBeNull();
  });

  it("the URL asked for is private when the content has tests or campaigns: a CDN must not share it", async () => {
    const req = page("/shoes", asCookie(visitorIn(true)));
    const draft = await decideDraft(testCMS(content), req);
    const visitor = decideVisitor(req, draft);
    const varies = await rewriteToAssignmentsRoute(testCMS(content), req, draft, visitor);
    expect(varies!.headers.get("cache-control")).toBe("private, no-cache");
    const campaignsOnly = testCMS(snapshot({ campaigns: { "black-friday": BF } }));
    expect(
      (await rewriteToAssignmentsRoute(campaignsOnly, req, draft, visitor))!.headers.get(
        "cache-control",
      ),
    ).toBe("private, no-cache");
    // Content with neither answers the same to everyone: Next's own headers stay.
    const plain = await rewriteToAssignmentsRoute(testCMS(), req, draft, visitor);
    expect(plain!.headers.get("cache-control")).toBeNull();
  });

  it("a campaign starting or ending changes the path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const cms = testCMS(content);
      const at = async (time: number) => {
        vi.setSystemTime(time);
        return routed(cms, page("/", asCookie(visitorIn(false))));
      };
      const before = await at(Date.parse(BF.start) - 1_000);
      const during = await at(Date.parse(BF.start) + 1_000);
      const after = await at(Date.parse(BF.end) + 1_000);
      expect(during).not.toBe(before);
      expect(parseAssignmentsSegment(before!.split("/")[2]!)).toEqual({
        experiments: { hero: false, later: false },
        campaigns: { "black-friday": false },
      });
      expect(parseAssignmentsSegment(during!.split("/")[2]!)).toEqual({
        experiments: { hero: false, later: false },
        campaigns: { "black-friday": true },
      });
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a draft or preview link is not rewritten for caching: it goes to the draft route", async () => {
    const cms = testCMS(
      snapshot({ previewHosts: ["shop.example.com"], experiments: { hero: 50 } }),
    );
    expect(await routed(cms, draftLink())).toBeNull();
    expect(await routed(cms, withCookie())).toBeNull();
    const draft = await decideDraft(cms, draftLink());
    expect(rewriteToDraftRoute(draftLink(), draft)?.headers.get("x-middleware-rewrite")).toContain(
      "/_draft/shoes",
    );
  });

  it("a path already on the assignments or draft route is never rewritten again", async () => {
    const cms = testCMS(content);
    expect(await routed(cms, page("/_assignments/-/shoes"))).toBeNull();
    expect(await routed(cms, page("/_draft/shoes"))).toBeNull();
    expect(isAssignmentsRoutePath("/_assignments")).toBe(true);
    expect(isAssignmentsRoutePath("/_assignments/x/shoes")).toBe(true);
    expect(isAssignmentsRoutePath("/_assignmentsly")).toBe(false);
    expect(ASSIGNMENTS_ROUTE_PREFIX).toBe("/_assignments");
  });

  it("draftProxy answers a direct hit on the assignments route with a 404, so a path can't force a test on", async () => {
    const cms = testCMS(content);
    const proxy = draftProxy(cms, { assignments: () => true });
    const forged = assignmentsRoutePath("/shoes", { experiments: { later: true }, campaigns: {} });
    expect((await proxy(page(forged))).status).toBe(404);
    const res = await proxy(page("/shoes", asCookie(visitorIn(false))));
    const segment = assignmentsSegment({
      experiments: { hero: false, later: false },
      campaigns: { "black-friday": false },
    });
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      `https://shop.example.com/_assignments/${segment}/shoes`,
    );
    // Without the option nothing changes.
    expect((await draftProxy(cms)(page("/shoes"))).headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("assignmentsSegment and parseAssignmentsSegment", () => {
  it("round-trip every name with its state, sorted, with one spelling per set of assignments", () => {
    const d = {
      experiments: { b: true, "a b": false, ç: true },
      campaigns: { "sale|x": true, "c=1": false, "-neg": true },
    };
    const segment = assignmentsSegment(d);
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseAssignmentsSegment(segment)).toEqual(d);
    expect(
      assignmentsSegment({
        experiments: Object.fromEntries(Object.entries(d.experiments).reverse()),
        campaigns: d.campaigns,
      }),
    ).toBe(segment);
    expect(assignmentsSegment({ experiments: {}, campaigns: {} })).toBe("-");
    expect(parseAssignmentsSegment("-")).toEqual({ experiments: {}, campaigns: {} });
  });

  it("rejects what the proxy never writes", () => {
    const b64 = (text: string) =>
      btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const bad of [
      "",
      "--",
      "not base64!",
      b64("x=+b,+a"), // unsorted
      b64("c=+a|x=+b"), // out of order
      b64("x=+a|x=+b"),
      b64("x=a"), // no state
      b64("v=sha|x=+a"), // a version never rides in the path
      b64("x="),
      `${b64("x=+a")}=`,
    ]) {
      expect(parseAssignmentsSegment(bad), bad).toBeNull();
    }
    expect(parseAssignmentsSegment(b64("x=+a,-b|c=-c"))).toEqual({
      experiments: { a: true, b: false },
      campaigns: { c: false },
    });
  });
});
