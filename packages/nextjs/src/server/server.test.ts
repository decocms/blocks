// @vitest-environment node
/**
 * The pages' half. `next/headers` is the request's headers, and React's
 * `cache()` (one slot per request in Server Components) is a slot per test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POINTER, snapshot, testCMS } from "../__tests__/fixtures.ts";

const request = vi.hoisted(() => ({ headers: new Headers(), reads: 0 }));

vi.mock("next/headers.js", () => ({
  headers: async () => {
    request.reads += 1;
    return request.headers;
  },
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slots = new Map<unknown, unknown>();
  (globalThis as { __resetCache?: () => void }).__resetCache = () => slots.clear();
  return {
    ...react,
    cache:
      <T>(fn: () => T) =>
      () => {
        if (!slots.has(fn)) slots.set(fn, fn());
        return slots.get(fn) as T;
      },
  };
});

const { activeDraftPointer, bindDraft, contentClient } = await import("./index.ts");

function serve(headers: Record<string, string>): void {
  request.headers = new Headers({ host: "shop.example.com", ...headers });
  request.reads = 0;
  (globalThis as { __resetCache?: () => void }).__resetCache?.();
}

const cookie = { cookie: `__deco_draft=${encodeURIComponent(POINTER)}` };

beforeEach(() => serve({}));

describe("bindDraft", () => {
  it("the page's ?__draft= first, then the proxy's x-deco-draft, then the cookie", async () => {
    const other = "studio.decocms.com/api/acme/decofile/mcp/other@v2";
    serve({ "x-deco-draft": other, ...cookie });
    expect(await bindDraft(testCMS(), { searchParams: { __draft: [POINTER, "x"] } })).toBe(true);
    expect(activeDraftPointer()).toBe(POINTER);

    serve({ "x-deco-draft": other, ...cookie });
    expect(await bindDraft(testCMS())).toBe(true);
    expect(activeDraftPointer()).toBe(other);

    serve(cookie);
    expect(await bindDraft(testCMS())).toBe(true);
    expect(activeDraftPointer()).toBe(POINTER);
  });

  it("?__draft=off and no draft leave the release", async () => {
    serve(cookie);
    expect(await bindDraft(testCMS(), { searchParams: { __draft: "off" } })).toBe(false);
    expect(activeDraftPointer()).toBe(null);
    serve({});
    expect(await bindDraft(testCMS())).toBe(false);
    serve({ "x-deco-draft": "junk" });
    expect(await bindDraft(testCMS())).toBe(false);
  });

  it("the same host allowlist as the proxy, on the visitor's host", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.shop.example.com"] }));
    serve({ "x-deco-draft": POINTER });
    expect(await bindDraft(cms, { site: "acme" })).toBe(false); // a forged header on a host that may not preview
    serve({ "x-deco-draft": POINTER, "x-forwarded-host": "acme.deco.site" });
    expect(await bindDraft(cms, { site: "acme" })).toBe(true);
    serve({ "x-deco-draft": POINTER, "x-forwarded-host": "acme.deco.site" });
    expect(await bindDraft(cms, { site: "acme", previewHosts: "none" })).toBe(false);
  });

  it("with previews off everywhere it never reads the request, so a static page stays static", async () => {
    serve(cookie);
    expect(await bindDraft(testCMS(snapshot({ previewHosts: [] })))).toBe(false);
    expect(await bindDraft(testCMS(), { previewHosts: "none" })).toBe(false);
    expect(request.reads).toBe(0);
  });
});

describe("contentClient", () => {
  it("the bound draft's client, else the release's", async () => {
    const cms = { forDraft: vi.fn(() => "draft"), forRelease: vi.fn(() => "release") };
    expect(contentClient(cms as never)).toBe("release");
    serve(cookie);
    await bindDraft(testCMS());
    expect(contentClient(cms as never)).toBe("draft");
    expect(cms.forDraft).toHaveBeenCalledWith(POINTER);
  });
});

describe("A/B tests: the assignments the proxy forwarded", () => {
  const withTests = () =>
    testCMS(snapshot({ previewHosts: ["shop.example.com"], experiments: { "buy-button": 50 } }));
  const buyButton = async () => (await contentClient(withTests()).resolve("BuyButton"))[0];

  it("reach the experiment matcher through bindDraft and contentClient", async () => {
    serve({ "x-deco-assignments": "buy-button" });
    expect(await bindDraft(withTests())).toBe(false);
    expect(await buyButton()).toBe("new");
    serve({ "x-deco-assignments": "" });
    await bindDraft(withTests());
    expect(await buyButton()).toBe("old");
    serve({});
    await bindDraft(withTests());
    expect(await buyButton()).toBe("old");
  });

  it("a draft's client gets none: the control, plus the variants its pointer forces", async () => {
    const cms = { forDraft: vi.fn(() => "draft"), forRelease: vi.fn(() => "release") };
    serve({ ...cookie, "x-deco-assignments": "buy-button" });
    expect(await bindDraft(withTests())).toBe(true);
    contentClient(cms as never);
    expect(cms.forDraft).toHaveBeenCalledWith(POINTER);
    expect(cms.forRelease).not.toHaveBeenCalled();
  });

  it("a release with no experiments never reads the header, so a static page stays static", async () => {
    serve({ "x-deco-assignments": "buy-button" });
    expect(await bindDraft(testCMS(snapshot({ previewHosts: [] })))).toBe(false);
    expect(request.reads).toBe(0);
    const cms = { forDraft: vi.fn(() => "draft"), forRelease: vi.fn(() => "release") };
    contentClient(cms as never);
    expect(cms.forRelease).toHaveBeenCalledWith();
  });
});
