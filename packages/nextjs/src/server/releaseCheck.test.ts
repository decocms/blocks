// @vitest-environment node
/**
 * One preview request, one check of the latest release (PO 2026-10-23): the
 * proxy makes it (`cms.checkRelease()`) and forwards its id on
 * `x-deco-release-check`, so its host check, its read of the draft, the
 * page's `bindDraft` host check and the page's draft reads share it:
 * exactly one `latest.json` fetch. `next/headers` is the request's headers,
 * and React's `cache()` a slot per test, as in server.test.ts.
 */
import { type Blocks, createCMS, resetForTests } from "@decocms/blocks";
import { NextRequest } from "next/server.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POINTER } from "../__tests__/fixtures.ts";
import { decideDraft, draftRequestHeaders } from "../proxy/index.ts";

const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers.js", () => ({ headers: async () => request.headers }));

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

const { bindDraft, contentClient } = await import("./index.ts");

const RELEASE_A = "aaaaaaaaaaaa-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a5a";
const RELEASE_B = "bbbbbbbbbbbb-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a5b";
const LATEST = "https://delivery.decocms.com/sites/acme/latest.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A hosted CMS that loaded release A, while `latest.json` now names B (a
 * publish this process hasn't picked up), the drafts' host answering POINTER,
 * and the URLs fetched after that first load.
 */
async function hosted() {
  resetForTests();
  let current = RELEASE_A;
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (url === LATEST) {
      return Response.json({ revision: current, previewHosts: ["shop.example.com"] });
    }
    for (const [id, title] of [
      [RELEASE_A, "A"],
      [RELEASE_B, "B"],
    ]) {
      if (url.endsWith(`/revisions/${id}/data.json`)) {
        return Response.json({ blocks: { Title: { __resolveType: "seo", title } } });
      }
    }
    if (url.startsWith("https://studio.decocms.com/")) {
      return Response.json({ set: {}, delete: [] }, { headers: { etag: '"e1"' } });
    }
    return new Response("not found", { status: 404 });
  });
  const cms = createCMS({ blocks: {} as Blocks, site: "acme" });
  expect(await cms.forRelease().revision()).toBe(RELEASE_A);
  current = RELEASE_B;
  urls.length = 0;
  return { cms, latestFetches: () => urls.filter((url) => url === LATEST).length };
}

/** The page's half: `bindDraft`, then two reads (a page and its layout). */
async function renderPage(cms: ReturnType<typeof hosted>["cms"], headers: Headers) {
  // Next hands the page the request's host.
  if (!headers.has("host")) headers.set("host", "shop.example.com");
  request.headers = headers;
  (globalThis as { __resetCache?: () => void }).__resetCache?.();
  expect(await bindDraft(cms)).toBe(true);
  const titles: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    const [entry] = await contentClient(cms).resolve<{ title: string }>("Title", { run: false });
    titles.push(entry?.title);
  }
  return titles;
}

const link = () =>
  new NextRequest(`https://shop.example.com/shoes?__draft=${encodeURIComponent(POINTER)}`);

describe("one release check per preview request", () => {
  it("a draft link through the proxy: its checks and the page's make one latest.json fetch", async () => {
    const { cms, latestFetches } = await hosted();
    const incoming = link();
    const decision = await decideDraft(cms, incoming);
    expect(decision.version?.version).toBe(POINTER);
    const forwarded = draftRequestHeaders(incoming, decision);
    expect(forwarded.get("x-deco-release-check")).toBe(decision.releaseCheck);
    // The draft shows over B, the release latest.json names.
    expect(await renderPage(cms, forwarded)).toEqual(["B", "B"]);
    expect(latestFetches()).toBe(1);

    // The next request checks again: no time-based throttle.
    const next = link();
    await renderPage(cms, draftRequestHeaders(next, await decideDraft(cms, next)));
    expect(latestFetches()).toBe(2);
  });

  it("a page the proxy didn't decide for makes one check of its own, shared by its reads", async () => {
    const { cms, latestFetches } = await hosted();
    const headers = new Headers({
      host: "shop.example.com",
      cookie: `__deco_draft=${encodeURIComponent(POINTER)}`,
      // A check id the CMS didn't make (forged, or another process's): a check of its own.
      "x-deco-release-check": "elsewhere:1",
    });
    expect(await renderPage(cms, headers)).toEqual(["B", "B"]);
    expect(latestFetches()).toBe(1);
  });

  it("the proxy drops a release-check id that arrives from outside", async () => {
    const { cms } = await hosted();
    const incoming = new NextRequest("https://shop.example.com/shoes", {
      headers: { "x-deco-release-check": "forged:1" },
    });
    const decision = await decideDraft(cms, incoming);
    expect(draftRequestHeaders(incoming, decision).has("x-deco-release-check")).toBe(false);
  });
});
