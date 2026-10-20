// @vitest-environment node
import { NextRequest, NextResponse } from "next/server.js";
import { describe, expect, it, vi } from "vitest";
import { POINTER, snapshot, testCMS } from "../__tests__/fixtures.ts";
import {
  applyAssignments,
  applyDraft,
  assignmentRequestHeaders,
  DRAFT_ROUTE_PREFIX,
  decideAssignments,
  decideDraft,
  draftProxy,
  draftRequestHeaders,
  isDraftRoutePath,
  rewriteToDraftRoute,
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

describe("decideDraft", () => {
  it("a draft link: the pointer, and the cookie that keeps the preview going", async () => {
    const d = await decideDraft(testCMS(), draftLink());
    expect(d.pointer).toBe(POINTER);
    expect(d.setCookie).toBe(await testCMS().draftCookie(draftLink()));
  });

  it("the cookie alone: the pointer, no new cookie", async () => {
    expect(await decideDraft(testCMS(), withCookie())).toEqual({
      pointer: POINTER,
      setCookie: null,
    });
  });

  it("no draft signal never asks the CMS", async () => {
    const real = testCMS();
    const cms = {
      draftPointer: vi.fn(async () => POINTER),
      settings: vi.fn(() => real.settings()),
      forRelease: vi.fn(() => real.forRelease()),
    };
    expect(await decideDraft(cms, new NextRequest("https://shop.example.com/shoes?q="))).toEqual({
      pointer: null,
      setCookie: null,
    });
    expect(cms.draftPointer).not.toHaveBeenCalled();
    expect(cms.settings).not.toHaveBeenCalled();
    expect(cms.forRelease).not.toHaveBeenCalled();
  });

  it("?__draft=off ends the preview on any host, kill switch included", async () => {
    const off = new NextRequest("https://shop.example.com/?__draft=off");
    const d = await decideDraft(testCMS(), off, { previewHosts: "none" });
    expect(d.pointer).toBe(null);
    expect(d.setCookie).toContain("Max-Age=0");
  });

  it("a host outside the allowlist gets the release", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.shop.example.com"] }));
    expect(await decideDraft(cms, draftLink(), { site: "acme" })).toEqual({
      pointer: null,
      setCookie: null,
    });
    expect(
      (await decideDraft(cms, draftLink("/", "acme.deco.site"), { site: "acme" })).pointer,
    ).toBe(POINTER);
    expect((await decideDraft(cms, draftLink("/", "staging.shop.example.com"))).pointer).toBe(
      POINTER,
    );
  });

  it("judges the host the visitor asked for (x-forwarded-host), not the origin's", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["shop.example.com"] }));
    const behindProxy = new NextRequest(
      `https://origin.internal/?__draft=${encodeURIComponent(POINTER)}`,
      { headers: { "x-forwarded-host": "shop.example.com" } },
    );
    expect((await decideDraft(cms, behindProxy)).pointer).toBe(POINTER);
    const direct = new NextRequest(
      `https://origin.internal/?__draft=${encodeURIComponent(POINTER)}`,
    );
    expect((await decideDraft(cms, direct)).pointer).toBe(null);
  });

  it("a pointer that doesn't parse is no draft and stores no cookie", async () => {
    expect(
      await decideDraft(testCMS(), new NextRequest("https://shop.example.com/?__draft=junk")),
    ).toEqual({
      pointer: null,
      setCookie: null,
    });
  });
});

describe("the request the proxy forwards", () => {
  it("carries the accepted pointer on x-deco-draft", () => {
    const h = draftRequestHeaders(withCookie(), { pointer: POINTER, setCookie: null });
    expect(h.get("x-deco-draft")).toBe(POINTER);
  });

  it("never carries a forged x-deco-draft", async () => {
    const forged = new NextRequest("https://shop.example.com/", {
      headers: { "x-deco-draft": POINTER },
    });
    const d = await decideDraft(testCMS(), forged);
    expect(draftRequestHeaders(forged, d).has("x-deco-draft")).toBe(false);
  });
});

describe("rewriteToDraftRoute", () => {
  it("rewrites a drafted request onto /_draft, keeping the path and query", () => {
    const res = rewriteToDraftRoute(draftLink("/shoes?sort=price"), {
      pointer: POINTER,
      setCookie: null,
    });
    const target = new URL(res?.headers.get("x-middleware-rewrite") ?? "");
    expect(target.pathname).toBe(`${DRAFT_ROUTE_PREFIX}/shoes`);
    expect(target.searchParams.get("sort")).toBe("price");
    expect(forwarded(res!, "x-deco-draft")).toBe(POINTER);
  });

  it("leaves the release and the draft route itself alone", () => {
    expect(rewriteToDraftRoute(draftLink(), { pointer: null, setCookie: null })).toBe(null);
    expect(
      rewriteToDraftRoute(draftLink("/_draft/shoes"), { pointer: POINTER, setCookie: null }),
    ).toBe(null);
    expect(isDraftRoutePath("/_draft")).toBe(true);
    expect(isDraftRoutePath("/_drafts")).toBe(false);
  });
});

describe("applyDraft", () => {
  it("a draft: the cookie, never stored, never indexed", () => {
    const res = applyDraft(NextResponse.next(), {
      pointer: POINTER,
      setCookie: "__deco_draft=x; Path=/",
    });
    expect(res.headers.get("set-cookie")).toBe("__deco_draft=x; Path=/");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("the release: nothing, except a cookie that ends a preview; the site's own cookies stay", () => {
    const res = NextResponse.next();
    res.headers.append("set-cookie", "a=1; Path=/");
    applyDraft(res, { pointer: null, setCookie: "__deco_draft=; Path=/; Max-Age=0" });
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "__deco_draft=; Path=/; Max-Age=0"]);
    expect(res.headers.has("x-robots-tag")).toBe(false);
    expect(res.headers.has("cache-control")).toBe(false);
  });
});

describe("draftProxy", () => {
  it("drafted: rewritten, forwarded, cookie and headers", async () => {
    const res = await draftProxy(testCMS(), { site: "acme" })(draftLink());
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/_draft/shoes");
    expect(res.headers.get("set-cookie")).toContain("__deco_draft=");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("rewrite: false keeps the route and still forwards the pointer", async () => {
    const res = await draftProxy(testCMS(), { rewrite: () => false })(withCookie());
    expect(res.headers.has("x-middleware-rewrite")).toBe(false);
    expect(forwarded(res, "x-deco-draft")).toBe(POINTER);
  });

  it("the release passes through, a forged header removed", async () => {
    const res = await draftProxy(testCMS())(
      new NextRequest("https://shop.example.com/", { headers: { "x-deco-draft": POINTER } }),
    );
    expect(res.headers.has("x-middleware-rewrite")).toBe(false);
    expect(forwarded(res, "x-deco-draft")).toBe(null);
    expect(res.headers.has("x-robots-tag")).toBe(false);
  });
});

describe("A/B tests: the visitor's assignments", () => {
  const withTests = (experiments: Record<string, number>) =>
    testCMS(snapshot({ previewHosts: ["shop.example.com"], experiments }));
  const release = { pointer: null, setCookie: null };
  const visit = (headers: Record<string, string> = {}, url = "https://shop.example.com/shoes") =>
    new NextRequest(url, { headers });
  const segmentCookies = (res: Response) =>
    res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));

  it("a first visit: the release's assignments and the deco_segment cookie", async () => {
    const d = await decideAssignments(
      withTests({ "buy-button": 100, "hero-copy": 0 }),
      visit(),
      release,
    );
    expect({ ...d.assignments }).toEqual({ "buy-button": true, "hero-copy": false });
    expect(d.setCookie).toMatch(
      /^deco_segment=[^;]+; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/,
    );
  });

  it("the cookie is written only when the assignments change", async () => {
    const cms = withTests({ "buy-button": 100 });
    const first = await decideAssignments(cms, visit(), release);
    const cookie = (first.setCookie as string).split(";")[0] as string;
    const again = await decideAssignments(cms, visit({ cookie }), release);
    expect({ ...again.assignments }).toEqual({ "buy-button": true });
    expect(again.setCookie).toBe(null);
    const res = applyAssignments(NextResponse.next(), again);
    expect(segmentCookies(res)).toEqual([]);
  });

  it("with no experiments: nothing forwarded, no cookie, the release never assigned", async () => {
    expect(await decideAssignments(testCMS(), visit(), release)).toEqual({
      assignments: null,
      setCookie: null,
    });
  });

  it("a draft: assigned for the draft's Experiments, and never the visitor's cookie", async () => {
    const cms = { experiments: vi.fn(async () => ({ "buy-button": 100 })) };
    const d = await decideAssignments(cms, visit(), { pointer: POINTER, setCookie: null });
    expect({ ...d.assignments }).toEqual({ "buy-button": true });
    expect(d.setCookie).toBe(null);
    expect(cms.experiments).toHaveBeenCalledWith(POINTER);
    // The draft adds a test the release doesn't have; the rewrite forwards it.
    const draft = {
      set: { Experiments: { __resolveType: "experiments", "buy-button": 100 } },
      delete: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(draft)),
    );
    try {
      const res = await draftProxy(withTests({ "hero-copy": 0 }))(draftLink());
      expect(segmentCookies(res)).toEqual([]);
      expect(forwarded(res, "x-deco-assignments")).toBe("buy-button");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("http (local development) gets a cookie without Secure; x-forwarded-proto wins", async () => {
    const cms = withTests({ "buy-button": 100 });
    const local = await decideAssignments(cms, visit({}, "http://localhost:3000/"), release);
    expect(local.setCookie).not.toContain("Secure");
    const behind = visit({ "x-forwarded-proto": "https" }, "http://localhost:3000/");
    expect((await decideAssignments(cms, behind, release)).setCookie).toContain("Secure");
  });

  it("forwards them on x-deco-assignments; a forged copy is always removed", async () => {
    const forged = visit({ "x-deco-assignments": "buy-button" });
    expect(draftRequestHeaders(forged, release).has("x-deco-assignments")).toBe(false);
    const none = await decideAssignments(testCMS(), forged, release);
    expect(
      assignmentRequestHeaders(draftRequestHeaders(forged, release), none).has(
        "x-deco-assignments",
      ),
    ).toBe(false);
    const off = await decideAssignments(withTests({ "buy-button": 0 }), forged, release);
    expect(
      assignmentRequestHeaders(draftRequestHeaders(forged, release), off).get("x-deco-assignments"),
    ).toBe("");
  });

  it("draftProxy: forwards the assignments and sets the cookie once", async () => {
    const proxy = draftProxy(withTests({ "buy-button": 100 }));
    const res = await proxy(visit({ "x-deco-assignments": "forged" }));
    expect(forwarded(res, "x-deco-assignments")).toBe("buy-button");
    const [cookie, ...more] = segmentCookies(res);
    expect(more).toEqual([]);
    const again = await proxy(visit({ cookie: (cookie as string).split(";")[0] as string }));
    expect(segmentCookies(again)).toEqual([]);
    expect(forwarded(again, "x-deco-assignments")).toBe("buy-button");
  });
});
