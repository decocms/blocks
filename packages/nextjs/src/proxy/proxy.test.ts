// @vitest-environment node
import { NextRequest, NextResponse } from "next/server.js";
import { describe, expect, it, vi } from "vitest";
import { POINTER, snapshot, testCMS } from "../__tests__/fixtures.ts";
import {
  applyDraft,
  DRAFT_ROUTE_PREFIX,
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
    const cms = { draftPointer: vi.fn(async () => POINTER) };
    expect(await decideDraft(cms, new NextRequest("https://shop.example.com/shoes?q="))).toEqual({
      pointer: null,
      setCookie: null,
    });
    expect(cms.draftPointer).not.toHaveBeenCalled();
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
