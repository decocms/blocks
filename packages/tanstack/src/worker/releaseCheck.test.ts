// @vitest-environment node
/**
 * One preview request, one check of the latest release (PO 2026-10-23): the
 * worker makes it (`cms.checkRelease()`) and hands it down, so its host
 * check, its read of the draft and the page's draft reads (`contentClient`,
 * through `x-deco-release-check`) share it: exactly one `latest.json` fetch.
 */
import { type Blocks, createCMS, resetForTests } from "@decocms/blocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecoWorker } from "./index.ts";
import { POINTER, TestContext } from "./testing.ts";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://store.example.com/"),
  setResponseHeader: () => {},
}));

const { contentClient } = await import("../server/index.ts");

const RELEASE_A = "aaaaaaaaaaaa-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a5a";
const RELEASE_B = "bbbbbbbbbbbb-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a5b";
const LATEST = "https://delivery.decocms.com/sites/acme/latest.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A hosted CMS that loaded release A, while `latest.json` now names B (a
 * publish this isolate hasn't picked up), the drafts' host answering POINTER,
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
      return Response.json({ revision: current, previewHosts: ["store.example.com"] });
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
  return { cms, urls };
}

describe("one release check per preview request", () => {
  it("a draft link: the host check, the worker's read of the draft and the page's reads make one latest.json fetch", async () => {
    const { cms, urls } = await hosted();
    const titles: unknown[] = [];
    const worker = createDecoWorker({
      cms,
      serverEntry: {
        fetch: async (request: Request) => {
          // Two reads, as a page and its layout make.
          for (let i = 0; i < 2; i++) {
            const [entry] = await contentClient(cms, request).resolve<{ title: string }>("Title", {
              run: false,
            });
            titles.push(entry?.title);
          }
          return new Response("<!doctype html><p>ok</p>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    });
    const ctx = new TestContext();
    const link = `https://store.example.com/?__draft=${encodeURIComponent(POINTER)}`;
    const response = await worker.fetch(new Request(link), {}, ctx);
    await ctx.settle();
    expect(response.status).toBe(200);
    // The draft shows over B, the release latest.json names.
    expect(titles).toEqual(["B", "B"]);
    expect(urls.filter((url) => url === LATEST)).toHaveLength(1);

    // The next request checks again: no time-based throttle.
    const again = await worker.fetch(new Request(link), {}, ctx);
    await ctx.settle();
    expect(again.status).toBe(200);
    expect(urls.filter((url) => url === LATEST)).toHaveLength(2);
  });

  it("a release-check id from outside never reaches the page", async () => {
    const { cms } = await hosted();
    const seen: (string | null)[] = [];
    const worker = createDecoWorker({
      cms,
      serverEntry: {
        fetch: async (request: Request) => {
          seen.push(request.headers.get("x-deco-release-check"));
          return new Response("<!doctype html><p>ok</p>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    });
    const ctx = new TestContext();
    const forged = { "x-deco-release-check": "forged:1" };
    await worker.fetch(new Request("https://store.example.com/", { headers: forged }), {}, ctx);
    const link = `https://store.example.com/?__draft=${encodeURIComponent(POINTER)}`;
    await worker.fetch(new Request(link, { headers: forged }), {}, ctx);
    await ctx.settle();
    expect(seen[0]).toBeNull();
    expect(seen[1]).not.toBe("forged:1");
    expect(seen[1]).toMatch(/:\d+$/);
  });
});
