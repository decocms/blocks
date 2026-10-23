// @vitest-environment node
/**
 * One preview request, one check of the latest release (PO 2026-10-23): the
 * worker makes it (`cms.checkRelease()`) and hands it down, so its host
 * check, its read of the draft and the page's draft reads (`contentClient`,
 * through `x-deco-release-check`) share it: exactly one `latest.json` fetch.
 */
import { type Blocks, createCMS, type Snapshot } from "@decocms/blocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecoWorker } from "./index.ts";
import { POINTER, TestContext } from "./testing.ts";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://store.example.com/"),
  setResponseHeader: () => {},
}));

const { contentClient } = await import("../server/index.ts");

const SCHEMA = "a".repeat(64);
const RELEASE_B = "b".repeat(40);
const LATEST = "https://delivery.decocms.com/sites/acme/latest.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

let roots = 0;

/**
 * A hosted CMS whose bundle holds release A while `latest.json` names B (a
 * publish this isolate hasn't picked up), the drafts' host answering POINTER,
 * and the URLs fetched.
 */
function hosted() {
  roots += 1;
  const blocks = { Title: { __resolveType: "seo", title: "A" } };
  const content = {
    revision: "a".repeat(40),
    schemaHash: SCHEMA,
    committedAt: "2026-01-01T00:00:00Z",
    blocks,
    root: `/release-check-${roots}`,
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
        previewHosts: ["store.example.com"],
      });
    }
    if (url.endsWith(`/revisions/${RELEASE_B}.json`)) {
      return Response.json({
        revision: RELEASE_B,
        schemaHash: SCHEMA,
        blocks: { Title: { __resolveType: "seo", title: "B" } },
        previewHosts: ["store.example.com"],
      });
    }
    if (url.startsWith("https://studio.decocms.com/")) {
      return Response.json({ set: {}, delete: [] }, { headers: { etag: '"e1"' } });
    }
    return new Response("not found", { status: 404 });
  });
  const cms = createCMS({ blocks: {} as Blocks, content, site: "acme" });
  return { cms, urls };
}

describe("one release check per preview request", () => {
  it("a draft link: the host check, the worker's read of the draft and the page's reads make one latest.json fetch", async () => {
    const { cms, urls } = hosted();
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
    const { cms } = hosted();
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
