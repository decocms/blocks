// @vitest-environment node
/**
 * client.list() was removed: it fetched the body of every block of a type.
 * The member stays (deprecated) so old code compiles, and throws at once,
 * before reading the index or fetching anything, with a message that names
 * what to read instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_REMOVED } from "./client";
import { createCMS, resetForTests } from "./cms";
import { docsBlocks, docsSnapshot, fakeDelivery } from "./testFixtures";
import type { Client } from "./types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TYPES = ["page", "redirect", "redirects", "website/pages/Page.tsx", "post", "seo", ""];

describe("client.list()", () => {
  it("throws for every type, with or without options, on local content", () => {
    const client = createCMS({ blocks: docsBlocks(), content: docsSnapshot() }).forRelease();
    for (const type of TYPES) {
      expect(() => client.list(type)).toThrow(LIST_REMOVED);
      expect(() => client.list(type, { run: true, limit: 1, where: () => true })).toThrow(
        LIST_REMOVED,
      );
    }
  });

  it("throws synchronously on a hosted release, before the index or any block is fetched", async () => {
    const api = fakeDelivery();
    const fetch = vi.fn(api.fetch);
    vi.stubGlobal("fetch", fetch);
    await api.publish({
      home: { __resolveType: "page", path: "/", sections: [] },
      Redirects: { __resolveType: "redirects", redirects: [] },
    });
    const client = createCMS({ blocks: docsBlocks(), site: "acme" }).forRelease();
    // createCMS starts polling the index on its own: let that settle first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fetch.mockClear();
    for (const type of TYPES) {
      expect(() => client.list(type)).toThrow(LIST_REMOVED);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    // Nothing was read, so the client never pinned an index.
    expect(client.version).toBeUndefined();
  });

  it("an awaited call rejects with the same error, so old code fails loudly", async () => {
    const client: Client = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
    }).forRelease();
    await expect(async () => await client.list("page")).rejects.toThrow(LIST_REMOVED);
  });

  it("says it was removed and names the replacements", () => {
    expect(LIST_REMOVED).toContain("client.list() was removed in this version");
    for (const replacement of [
      "client.routes()",
      "client.redirects()",
      "client.entries(type)",
      "client.resolve(name)",
      "index only",
    ]) {
      expect(LIST_REMOVED).toContain(replacement);
    }
  });

  it("warns nothing: it throws instead", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createCMS({ blocks: docsBlocks(), content: docsSnapshot() }).forRelease();
    expect(() => client.list("page")).toThrow(Error);
    expect(warn).not.toHaveBeenCalled();
  });
});
