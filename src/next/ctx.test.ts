import { describe, expect, it } from "vitest";
import { buildMatcherContextFromNext } from "./ctx";

describe("buildMatcherContextFromNext", () => {
  it("extracts userAgent, url, path, cookies, headers from a Request", () => {
    const req = new Request("http://example.test/products/foo?bar=1", {
      headers: {
        "user-agent": "vitest",
        "cookie": "session=abc; theme=dark",
        "x-forwarded-host": "example.test",
      },
    });
    const ctx = buildMatcherContextFromNext(req);
    expect(ctx.userAgent).toBe("vitest");
    expect(ctx.url).toBe("http://example.test/products/foo?bar=1");
    expect(ctx.path).toBe("/products/foo");
    expect(ctx.cookies?.session).toBe("abc");
    expect(ctx.cookies?.theme).toBe("dark");
    expect(ctx.headers?.["user-agent"]).toBe("vitest");
    expect(ctx.request).toBe(req);
  });

  it("returns empty defaults when headers/cookies are absent", () => {
    const req = new Request("http://example.test/");
    const ctx = buildMatcherContextFromNext(req);
    expect(ctx.userAgent).toBe("");
    expect(ctx.cookies).toEqual({});
  });
});
