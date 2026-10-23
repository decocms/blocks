// @vitest-environment node
/** The draft names and the draft response headers the proxy, the pages and withDeco() share. */
import { describe, expect, it } from "vitest";
import { ASSIGNMENTS_HEADER } from "./assignments";
import { DRAFT_COOKIE, DRAFT_PARAM, draftResponseHeaders, VERSION_HEADER } from "./draft";
import { VISITOR_HEADER } from "./visitor";

const POINTER = "api.deco.example/drafts/acme/main?token=abc.def-ghi@9f3c1a";

describe("the draft names", () => {
  it("pins the values (v7's, which Studio's links and live previews use)", () => {
    expect(DRAFT_PARAM).toBe("__draft");
    expect(DRAFT_COOKIE).toBe("__deco_draft");
    expect(VERSION_HEADER).toBe("x-deco-version");
    expect(VISITOR_HEADER).toBe("x-deco-visitor");
    expect(ASSIGNMENTS_HEADER).toBe("x-deco-assignments");
  });
});

describe("draftResponseHeaders", () => {
  it("a preview is always revalidated (max-age=0, no-cache, must-revalidate), never indexed", () => {
    expect(draftResponseHeaders(POINTER)).toEqual({
      "Cache-Control": "max-age=0, no-cache, must-revalidate",
      Vary: "Cookie",
      "X-Robots-Tag": "noindex, nofollow",
    });
  });

  it("nothing for a request without a draft", () => {
    expect(draftResponseHeaders(null)).toEqual({});
    expect(draftResponseHeaders(undefined)).toEqual({});
    expect(draftResponseHeaders("")).toEqual({});
    expect(draftResponseHeaders(false)).toEqual({});
  });

  it("the same headers for any draft signal (true): ?__draft=off, a refused or unavailable draft", () => {
    expect(draftResponseHeaders(true)).toEqual(draftResponseHeaders(POINTER));
  });

  it("each call returns its own object", () => {
    const a = draftResponseHeaders(POINTER);
    a.Vary = "Accept";
    expect(draftResponseHeaders(POINTER).Vary).toBe("Cookie");
  });

  it("applies to a Response's headers", () => {
    const response = new Response("x", { headers: draftResponseHeaders(POINTER) });
    expect(response.headers.get("cache-control")).toBe("max-age=0, no-cache, must-revalidate");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
