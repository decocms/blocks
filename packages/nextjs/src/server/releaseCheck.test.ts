// @vitest-environment node
/**
 * One preview request, one check of the latest release (PO 2026-10-23): the
 * proxy makes it (`cms.checkRelease()`) and forwards its id on
 * `x-deco-release-check`, so its host check, its read of the draft, the
 * page's `bindDraft` host check and the page's draft reads share it:
 * exactly one `latest.json` fetch. `next/headers` is the request's headers,
 * and React's `cache()` a slot per test, as in server.test.ts.
 */
import { type Blocks, createCMS, type Snapshot } from "@decocms/blocks";
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

const SCHEMA = "a".repeat(64);
const RELEASE_B = "b".repeat(40);
const LATEST = "https://delivery.decocms.com/sites/acme/latest.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

let roots = 0;

/**
 * A hosted CMS whose bundle holds release A while `latest.json` names B (a
 * publish this process hasn't picked up), the drafts' host answering POINTER,
 * and the URLs fetched.
 */
function hosted() {
  roots += 1;
  const content = {
    revision: "a".repeat(40),
    schemaHash: SCHEMA,
    committedAt: "2026-01-01T00:00:00Z",
    blocks: { Title: { __resolveType: "seo", title: "A" } },
    root: `/next-release-check-${roots}`,
  } as Snapshot & { root: string };
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (url === LATEST) {
      return Response.json({
        revision: RELEASE_B,
        schemaHash: SCHEMA,
        publishedAt: new Date().toISOString(),
        previewHosts: ["shop.example.com"],
      });
    }
    if (url.endsWith(`/revisions/${RELEASE_B}.json`)) {
      return Response.json({
        revision: RELEASE_B,
        schemaHash: SCHEMA,
        blocks: { Title: { __resolveType: "seo", title: "B" } },
        previewHosts: ["shop.example.com"],
      });
    }
    if (url.startsWith("https://studio.decocms.com/")) {
      return Response.json({ set: {}, delete: [] }, { headers: { etag: '"e1"' } });
    }
    return new Response("not found", { status: 404 });
  });
  const cms = createCMS({ blocks: {} as Blocks, content, site: "acme" });
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
    const { cms, latestFetches } = hosted();
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
    const { cms, latestFetches } = hosted();
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
    const { cms } = hosted();
    const incoming = new NextRequest("https://shop.example.com/shoes", {
      headers: { "x-deco-release-check": "forged:1" },
    });
    const decision = await decideDraft(cms, incoming);
    expect(draftRequestHeaders(incoming, decision).has("x-deco-release-check")).toBe(false);
  });
});
