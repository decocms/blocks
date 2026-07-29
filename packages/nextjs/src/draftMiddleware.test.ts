import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DRAFT_COOKIE } from "./draft";
import { applyDraft, prepareDraft, rewriteToDraftRoute } from "./draftMiddleware";

beforeEach(() => {
  // The middleware is host-gated; these tests run as the allowed host.
  process.env.DECO_ALLOWED_PREVIEW_HOSTS = "site.example";
});
afterEach(() => {
  delete process.env.DECO_ALLOWED_PREVIEW_HOSTS;
});

function request(url: string, cookie?: string): NextRequest {
  const req = new NextRequest(new URL(url), {
    headers: cookie ? { cookie: `${DRAFT_COOKIE}=${cookie}` } : {},
  });
  return req;
}

describe("prepareDraft", () => {
  it("reads the pointer from the param", () => {
    expect(prepareDraft(request("https://site.example/p?__draft=abc.localhost@v1")).pointer).toBe(
      "abc.localhost@v1",
    );
  });

  it("reads the pointer from the cookie on a plain navigation", () => {
    expect(prepareDraft(request("https://site.example/p", "abc.localhost@v1")).pointer).toBe(
      "abc.localhost@v1",
    );
  });

  it("is inert on a host outside the allowlist — the production domain", () => {
    // Same build, different Host: no cookie, no rewrite, nothing touched.
    const req = request("https://fila.com.br/p?__draft=abc@v1");
    process.env.DECO_ALLOWED_PREVIEW_HOSTS = "fila.vtex.app";
    expect(prepareDraft(req)).toEqual({ pointer: null, setCookie: null, clearCookie: false });
    expect(rewriteToDraftRoute(req, prepareDraft(req))).toBeNull();
  });

  it("ignores a client-supplied draft header — the page owns the decision", () => {
    // There is no request-header path any more; the page reads searchParams
    // and cookies itself, so a forged header is simply not an input.
    const req = new NextRequest(new URL("https://site.example/p"), {
      headers: { "x-deco-draft": "attacker.localhost@v1" },
    });
    expect(prepareDraft(req).pointer).toBeNull();
  });
});

describe("applyDraft", () => {
  it("sets a partitioned cross-site cookie when entering draft mode", () => {
    const decision = prepareDraft(request("https://site.example/p?__draft=abc.localhost@v1"));
    const res = applyDraft(NextResponse.next(), decision);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${DRAFT_COOKIE}=abc.localhost%40v1`);
    // The preview iframe is cross-site, so these attributes are what make the
    // cookie survive at all — not hardening extras.
    expect(setCookie).toMatch(/SameSite=None/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Partitioned/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it("marks a draft response uncacheable and unindexable", () => {
    // With the pointer in a cookie, draft and published share a URL — a CDN
    // keyed on URL alone would serve unpublished content to a real visitor.
    const decision = prepareDraft(request("https://site.example/p", "abc.localhost@v1"));
    const res = applyDraft(NextResponse.next(), decision);

    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("leaves an ordinary response completely untouched", () => {
    const decision = prepareDraft(request("https://site.example/p"));
    const res = applyDraft(NextResponse.next(), decision);

    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("clears the cookie on ?__draft=off", () => {
    const decision = prepareDraft(
      request("https://site.example/p?__draft=off", "abc.localhost@v1"),
    );
    expect(decision.clearCookie).toBe(true);

    const res = applyDraft(NextResponse.next(), decision);
    const setCookie = res.headers.get("set-cookie") ?? "";
    // Deletion is a set with an immediate expiry.
    expect(setCookie).toContain(DRAFT_COOKIE);
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    // And the response is not treated as a draft render.
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("rewriteToDraftRoute", () => {
  it("rewrites a drafted request onto the dynamic draft route", () => {
    const req = request("https://site.example/blog/hello?__draft=abc.localhost@v1");
    const res = rewriteToDraftRoute(req, prepareDraft(req));
    const target = new URL(res?.headers.get("x-middleware-rewrite") ?? "");
    expect(target.pathname).toBe("/_draft/blog/hello");
    // The pointer must survive: the draft page reads it from searchParams.
    expect(target.searchParams.get("__draft")).toBe("abc.localhost@v1");
  });

  it("rewrites a cookie-only navigation too", () => {
    const req = request("https://site.example/blog/hello", "abc.localhost@v1");
    const res = rewriteToDraftRoute(req, prepareDraft(req));
    expect(new URL(res?.headers.get("x-middleware-rewrite") ?? "").pathname).toBe(
      "/_draft/blog/hello",
    );
  });

  it("leaves an ordinary request alone — ISR must not be disturbed", () => {
    // The whole point: only drafted requests go dynamic. A shopper's request
    // must reach the real, statically rendered route untouched.
    const req = request("https://site.example/blog/hello");
    expect(rewriteToDraftRoute(req, prepareDraft(req))).toBeNull();
  });

  it("never nests the prefix when middleware re-runs on the rewritten URL", () => {
    const req = request("https://site.example/_draft/blog/hello?__draft=abc.localhost@v1");
    expect(rewriteToDraftRoute(req, prepareDraft(req))).toBeNull();
  });

  it("does not rewrite when leaving draft mode", () => {
    const req = request("https://site.example/blog/hello?__draft=off", "abc.localhost@v1");
    expect(rewriteToDraftRoute(req, prepareDraft(req))).toBeNull();
  });
});
