// @vitest-environment node
import { parseVisitor, serializeVisitor } from "@decocms/blocks/experiments";
import { NextRequest, NextResponse } from "next/server.js";
import { describe, expect, it, vi } from "vitest";
import { POINTER, snapshot, testCMS } from "../__tests__/fixtures.ts";
import {
  applyDraft,
  applyVisitor,
  DRAFT_ROUTE_PREFIX,
  decideDraft,
  decideVisitor,
  draftProxy,
  draftRequestHeaders,
  isDraftRoutePath,
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
      readVersion: vi.fn(async () => POINTER),
      settings: vi.fn(() => real.settings()),
      forRelease: vi.fn(() => real.forRelease()),
    };
    expect(await decideDraft(cms, new NextRequest("https://shop.example.com/shoes?q="))).toEqual({
      pointer: null,
      setCookie: null,
    });
    expect(cms.readVersion).not.toHaveBeenCalled();
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

describe("the visitor", () => {
  const release = { pointer: null, setCookie: null };
  const preview = { pointer: POINTER, setCookie: null };
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
    expect(forwarded(res, "x-deco-draft")).toBe(POINTER);
    expect(parseVisitor(forwarded(res, "x-deco-visitor"))).not.toBe(null);
    expect(segmentCookies(res)).toEqual([]);
  });
});

describe("the version: an old release from a Studio link", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const link = (value: string, host = "shop.example.com") =>
    new NextRequest(`https://${host}/shoes?__draft=${encodeURIComponent(value)}`);
  const cms = () => testCMS(snapshot({ previewHosts: ["shop.example.com"] }));

  it("a release SHA, with or without the preview parameters, is the version forwarded", async () => {
    const plain = await decideDraft(cms(), link(SHA));
    expect(plain.pointer).toBe(SHA);
    expect(plain.setCookie).toContain(`__deco_draft=${SHA};`);
    const at = encodeURIComponent("2026-11-28T10:00:00-03:00");
    const version = `${SHA}?__at=${at}&__test=${encodeURIComponent("hero=off")}`;
    expect((await decideDraft(cms(), link(version))).pointer).toBe(version);
  });

  it("on a host that may not preview, or when it doesn't parse: the current release", async () => {
    expect((await decideDraft(cms(), link(SHA, "elsewhere.example.com"))).pointer).toBe(null);
    expect((await decideDraft(cms(), link(SHA.slice(1)))).pointer).toBe(null);
    expect((await decideDraft(cms(), link(`${SHA}?__at=yesterday`))).pointer).toBe(null);
    expect((await decideDraft(cms(), link(`${SHA}?page=2`))).pointer).toBe(null);
  });
});
