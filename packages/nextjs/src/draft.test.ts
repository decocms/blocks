import { describe, expect, it } from "vitest";

import { DRAFT_COOKIE_OPTIONS, DRAFT_PARAM, decideDraft } from "./draft";

function urlWith(param?: string): URL {
  const url = new URL("https://site.example/some/page");
  if (param !== undefined) url.searchParams.set(DRAFT_PARAM, param);
  return url;
}

describe("decideDraft", () => {
  it("enters draft mode from the param and sets the cookie", () => {
    expect(decideDraft(urlWith("abc@v1"), null)).toEqual({
      pointer: "abc@v1",
      setCookie: "abc@v1",
      clearCookie: false,
    });
  });

  it("carries the draft across navigation via the cookie alone", () => {
    // The param is gone — this is the in-preview link click that a
    // param-only design would silently drop back to published.
    expect(decideDraft(urlWith(), "abc@v1")).toEqual({
      pointer: "abc@v1",
      setCookie: null,
      clearCookie: false,
    });
  });

  it("lets the param override a stale cookie", () => {
    // Studio navigating to a newer version must win over the older pointer
    // still sitting in the cookie, or a save would never be reflected.
    expect(decideDraft(urlWith("abc@v2"), "abc@v1")).toEqual({
      pointer: "abc@v2",
      setCookie: "abc@v2",
      clearCookie: false,
    });
  });

  it("leaves draft mode on ?__draft=off, even with a cookie set", () => {
    expect(decideDraft(urlWith("off"), "abc@v1")).toEqual({
      pointer: null,
      setCookie: null,
      clearCookie: true,
    });
  });

  it("is inert for an ordinary request", () => {
    expect(decideDraft(urlWith(), null)).toEqual({
      pointer: null,
      setCookie: null,
      clearCookie: false,
    });
  });
});

describe("DRAFT_COOKIE_OPTIONS", () => {
  it("is set up to survive a cross-site preview iframe", () => {
    // The preview iframe is cross-site (Studio embeds the production origin),
    // so the cookie is third-party. Without SameSite=None+Secure it is never
    // sent; without Partitioned (CHIPS) it is dropped as browsers wind down
    // unpartitioned third-party cookies. These attributes are load-bearing,
    // not incidental.
    expect(DRAFT_COOKIE_OPTIONS.sameSite).toBe("none");
    expect(DRAFT_COOKIE_OPTIONS.secure).toBe(true);
    expect(DRAFT_COOKIE_OPTIONS.partitioned).toBe(true);
    expect(DRAFT_COOKIE_OPTIONS.httpOnly).toBe(true);
  });

  it("is short-lived so a stale pointer can't pin an old version", () => {
    expect(DRAFT_COOKIE_OPTIONS.maxAge).toBeLessThanOrEqual(60 * 60);
  });
});
