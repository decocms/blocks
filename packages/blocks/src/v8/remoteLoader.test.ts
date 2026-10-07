// @vitest-environment node
/**
 * remoteLoader (hosted-releases-internals.mdx, hosted-publishing.mdx,
 * content-delivery.mdx): requests read memory, and the background check
 * follows `sites/<site>/latest.json`. Drafts aren't the loader's (see
 * draftChanges.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { remoteLoader } from "./remoteLoader";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Loader, Snapshot } from "./types";

const ORIGIN = "https://delivery.decocms.com";
const SITE = "acme";
const LATEST_URL = `${ORIGIN}/sites/acme/latest.json`;
const SCHEMA = "a".repeat(64);
const OTHER_SCHEMA = "b".repeat(64);
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The bundled content module: a content-hash revision and the schema it was built with. */
function bundled(schemaHash: string | null = SCHEMA, builtAt?: string): Snapshot {
  const snapshot: Snapshot = {
    ...docsSnapshot(),
    aliases: { "website/sections/Seo.tsx": "seo" },
  };
  if (schemaHash !== null) snapshot.schemaHash = schemaHash;
  if (builtAt !== undefined) snapshot.builtAt = builtAt;
  return snapshot;
}

/** What Studio writes for a commit: the blocks at that commit. */
function blocksAt(title: string): Record<string, unknown> {
  return { SummerSEO: { __resolveType: "seo", title, description: "d" } };
}

/** A fake delivery CDN: `latest.json` and immutable `revisions/<sha>.json`. */
function delivery() {
  const objects = new Map<string, unknown>();
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const key = url.slice(ORIGIN.length);
    if (!objects.has(key)) return new Response("not found", { status: 404 });
    return Response.json(objects.get(key));
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    requests,
    urls: () => requests.map((r) => r.url),
    /** Studio's publish: the revision, then the pointer. */
    publish(
      sha: string,
      title: string,
      schemaHash = SCHEMA,
      publishedAt = "2026-10-06T12:00:00.000Z",
    ) {
      objects.set(`/sites/acme/revisions/${sha}.json`, {
        revision: sha,
        schemaHash,
        blocks: blocksAt(title),
      });
      objects.set("/sites/acme/latest.json", {
        revision: sha,
        schemaHash,
        publishedAt,
      });
    },
    /** Studio's "Make current": rewrites the pointer only. */
    point(value: unknown) {
      objects.set("/sites/acme/latest.json", value);
    },
    put(key: string, value: unknown) {
      objects.set(key, value);
    },
    remove(key: string) {
      objects.delete(key);
    },
  };
}

describe("remoteLoader: boot", () => {
  it("load() serves the bundled content from memory and never touches the network", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const fallback = bundled();
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.load()).toBe(fallback);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("createCMS with site makes no request before the first background check", async () => {
    const api = delivery();
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: SITE });
    expect(api.fetch).not.toHaveBeenCalled();
    expect(await cms.forRelease().revision()).toBe("rev-1");
  });
});

describe("remoteLoader: update()", () => {
  it("reads latest.json with no credentials, downloads revisions/<sha>.json and swaps it in whole", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const fallback = bundled();
    const loader = remoteLoader(fallback, { site: SITE });

    expect(await loader.update?.()).toEqual({ updated: true });
    expect(api.urls()).toEqual([LATEST_URL, `${ORIGIN}/sites/acme/revisions/${SHA_1}.json`]);
    expect(api.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    expect(await loader.load()).toEqual({
      revision: SHA_1,
      schemaHash: SCHEMA,
      blocks: blocksAt("Published"),
      aliases: fallback.aliases, // the bundled alias table: aliases come from code
    });
  });

  it("the first check downloads even content equal to the bundle's: no comparison with the bundle", async () => {
    const api = delivery();
    const fallback = bundled();
    api.put(`/sites/acme/revisions/${SHA_1}.json`, {
      revision: SHA_1,
      schemaHash: SCHEMA,
      blocks: fallback.blocks,
    });
    api.point({ revision: SHA_1, schemaHash: SCHEMA, publishedAt: "2026-10-06T12:00:00.000Z" });
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(api.urls()).toHaveLength(2);
    expect((await loader.load()).revision).toBe(SHA_1);
  });

  it("the same revision as the one last swapped in downloads nothing", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const loader = remoteLoader(bundled(), { site: SITE });
    await loader.update?.();
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.urls()).toEqual([
      LATEST_URL,
      `${ORIGIN}/sites/acme/revisions/${SHA_1}.json`,
      LATEST_URL,
    ]);
  });

  it("follows the pointer it reads, older revisions included (a rollback), with no ordering among pointers", async () => {
    const api = delivery();
    api.publish(SHA_1, "One");
    api.publish(SHA_2, "Two");
    const loader = remoteLoader(bundled(), { site: SITE });
    await loader.update?.();
    expect((await loader.load()).revision).toBe(SHA_2);

    api.point({ revision: SHA_1, schemaHash: SCHEMA, publishedAt: "2026-01-01T00:00:00.000Z" });
    expect(await loader.update?.()).toEqual({ updated: true });
    const loaded = await loader.load();
    expect(loaded.revision).toBe(SHA_1);
    expect(loaded.blocks).toEqual(blocksAt("One"));
  });

  it("swaps only when schemaHash equals the bundled content's; otherwise keeps the bundle", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published", OTHER_SCHEMA);
    const fallback = bundled();
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.urls()).toEqual([LATEST_URL]);
    expect(await loader.load()).toBe(fallback);
  });

  it("a process that already swapped keeps its release when the pointer's schema stops matching", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const loader = remoteLoader(bundled(), { site: SITE });
    await loader.update?.();
    api.publish(SHA_2, "Next schema", OTHER_SCHEMA);
    expect(await loader.update?.()).toEqual({ updated: false });
    expect((await loader.load()).revision).toBe(SHA_1);
  });

  it("bundled content without a schemaHash never swaps and never fetches", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const fallback = bundled(null);
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.fetch).not.toHaveBeenCalled();
    expect(await loader.load()).toBe(fallback);
  });

  it("404 (nothing published), 500 and network errors keep memory; the next check retries", async () => {
    const api = delivery();
    const fallback = bundled();
    const loader = remoteLoader(fallback, { site: SITE });
    await expect(loader.update?.()).rejects.toThrow(/HTTP 404/);
    expect(await loader.load()).toBe(fallback);

    api.fetch.mockResolvedValueOnce(new Response("down", { status: 500 }));
    await expect(loader.update?.()).rejects.toThrow(/HTTP 500/);
    api.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(loader.update?.()).rejects.toThrow(/fetch failed/);
    expect(await loader.load()).toBe(fallback);

    api.publish(SHA_1, "Published");
    expect(await loader.update?.()).toEqual({ updated: true });
  });

  it("a revision whose download failed is retried on the next check", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const key = `/sites/acme/revisions/${SHA_1}.json`;
    const stored = { revision: SHA_1, schemaHash: SCHEMA, blocks: blocksAt("Published") };
    api.remove(key);
    const fallback = bundled();
    const loader = remoteLoader(fallback, { site: SITE });
    await expect(loader.update?.()).rejects.toThrow(/HTTP 404/);
    expect(await loader.load()).toBe(fallback);
    api.put(key, stored);
    expect(await loader.update?.()).toEqual({ updated: true });
  });

  it("refuses a malformed latest.json, downloading nothing", async () => {
    const api = delivery();
    const loader = remoteLoader(bundled(), { site: SITE });
    for (const pointer of [
      null,
      [],
      { revision: SHA_1, schemaHash: SCHEMA }, // no publishedAt
      { revision: "abc", schemaHash: SCHEMA, publishedAt: "x" }, // not a commit SHA
      { revision: "../../other/revisions/x", schemaHash: SCHEMA, publishedAt: "x" },
      { revision: "A".repeat(40), schemaHash: SCHEMA, publishedAt: "x" }, // lowercase hex only
      { revision: SHA_1, schemaHash: "short", publishedAt: "x" },
      { revision: SHA_1, schemaHash: SCHEMA, publishedAt: 1 },
    ]) {
      api.point(pointer);
      await expect(loader.update?.()).rejects.toThrow(/latest\.json: unexpected format/);
    }
    expect(api.urls().every((url) => url === LATEST_URL)).toBe(true);
  });

  it("refuses a revision body that isn't the one latest.json names, keeping memory", async () => {
    const api = delivery();
    const fallback = bundled();
    const loader = remoteLoader(fallback, { site: SITE });
    api.point({ revision: SHA_1, schemaHash: SCHEMA, publishedAt: "x" });
    for (const body of [
      { revision: SHA_2, schemaHash: SCHEMA, blocks: {} },
      { revision: SHA_1, schemaHash: OTHER_SCHEMA, blocks: {} },
      { revision: SHA_1, schemaHash: SCHEMA, blocks: [] },
      { revision: SHA_1, schemaHash: SCHEMA },
    ]) {
      api.put(`/sites/acme/revisions/${SHA_1}.json`, body);
      await expect(loader.update?.()).rejects.toThrow(/unexpected format/);
      expect(await loader.load()).toBe(fallback);
    }
  });

  it("doesn't verify a content hash: the revision id is the commit SHA", async () => {
    const api = delivery();
    api.publish(SHA_1, "Whatever the commit holds");
    const loader = remoteLoader(bundled(), { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: true });
  });

  it("keeps local files in development: NODE_ENV=development never fetches", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const api = delivery();
    api.publish(SHA_1, "Published");
    const fallback = bundled();
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(await loader.load()).toBe(fallback);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("works over a fallback loader, reading its schemaHash from what it loads", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const fallback = bundled();
    const load = vi.fn(async () => fallback);
    const loader = remoteLoader({ load }, { site: SITE });
    expect(await loader.load()).toBe(fallback);
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a fallback loader that can't load can't be compared: no swap", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const failing: Loader = { load: () => Promise.reject(new Error("no key")) };
    const loader = remoteLoader(failing, { site: SITE });
    await expect(loader.update?.()).rejects.toThrow("no key");
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe("remoteLoader: whoever is newer wins (publishedAt vs the bundle's builtAt)", () => {
  const T = (hour: number) => `2026-10-07T${String(hour).padStart(2, "0")}:00:00.000Z`;

  it("publish, then deploy: the bundle built later wins; nothing is downloaded", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published", SCHEMA, T(10));
    const fallback = bundled(SCHEMA, T(11));
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.urls()).toEqual([LATEST_URL]);
    expect(await loader.load()).toBe(fallback);
  });

  it("deploy, then publish: the release published later wins", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published", SCHEMA, T(12));
    const loader = remoteLoader(bundled(SCHEMA, T(11)), { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: true });
    expect((await loader.load()).blocks).toEqual(blocksAt("Published"));
  });

  it("a publish at the bundle's exact builtAt keeps the bundle", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published", SCHEMA, T(11));
    const loader = remoteLoader(bundled(SCHEMA, T(11)), { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
  });

  it("rollback after a deploy: Make current writes publishedAt = now, so the CDN wins", async () => {
    const api = delivery();
    api.publish(SHA_1, "One", SCHEMA, T(9));
    const loader = remoteLoader(bundled(SCHEMA, T(11)), { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
    api.point({ revision: SHA_1, schemaHash: SCHEMA, publishedAt: T(12) });
    expect(await loader.update?.()).toEqual({ updated: true });
    expect((await loader.load()).revision).toBe(SHA_1);
  });

  it("deploy after a rollback: the bundle built later wins", async () => {
    const api = delivery();
    api.publish(SHA_1, "One", SCHEMA, T(9));
    api.point({ revision: SHA_1, schemaHash: SCHEMA, publishedAt: T(12) }); // the rollback
    const fallback = bundled(SCHEMA, T(13));
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(await loader.load()).toBe(fallback);
  });

  it("a newer release with another schema keeps the bundle", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published", OTHER_SCHEMA, T(12));
    const fallback = bundled(SCHEMA, T(11));
    const loader = remoteLoader(fallback, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(await loader.load()).toBe(fallback);
  });

  it("a bundle without builtAt is the oldest: a release with its schema wins", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published", SCHEMA, "1970-01-01T00:00:00.000Z");
    const loader = remoteLoader(bundled(SCHEMA), { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: true });
    expect((await loader.load()).revision).toBe(SHA_1);
  });

  it("a fallback loader's builtAt is read from what it loads", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published", SCHEMA, T(10));
    const custom: Loader = { load: async () => bundled(SCHEMA, T(11)) };
    const loader = remoteLoader(custom, { site: SITE });
    expect(await loader.update?.()).toEqual({ updated: false });
  });

  it("refuses a latest.json whose publishedAt isn't a date", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    api.point({ revision: SHA_1, schemaHash: SCHEMA, publishedAt: "yesterday-ish" });
    const loader = remoteLoader(bundled(), { site: SITE });
    await expect(loader.update?.()).rejects.toThrow(/latest\.json: unexpected format/);
  });
});

describe("remoteLoader with createCMS", () => {
  it("site alone wraps the content: a check swaps the release in for the next client", async () => {
    const api = delivery();
    api.publish(SHA_1, "Published");
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: SITE });

    const before = cms.forRelease();
    expect(await before.revision()).toBe("rev-1");
    expect(await cms.update()).toEqual({ updated: true });
    expect(await before.revision()).toBe("rev-1"); // a client keeps its revision
    const client = cms.forRelease();
    expect(await client.revision()).toBe(SHA_1);
    const [seo] = await client.resolve<{ title: string }>("SummerSEO");
    expect(seo?.title).toBe("Published");
  });

  it("a token without site is a configuration error, before anything is fetched", async () => {
    const api = delivery();
    expect(() =>
      createCMS({
        blocks: docsBlocks(),
        content: bundled(),
        token: "t",
        telemetry: false,
      }),
    ).toThrow("token needs site: pass both, or site alone");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("is one instance per process: the same site and fallback share it; another interval warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = bundled();
    const first = remoteLoader(fallback, { site: SITE });
    expect(remoteLoader(fallback, { site: SITE })).toBe(first);
    expect(remoteLoader(fallback, { site: SITE, interval: 120_000 })).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interval"));
    expect(remoteLoader(fallback, { site: "other" })).not.toBe(first);
  });

  it("createCMS paces a remoteLoader by its own interval when it has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    delivery();
    const loader = remoteLoader(bundled(), { site: SITE, interval: 300_000 });
    const update = vi.spyOn(loader, "update" as never);
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    cms.forRelease();
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.setSystemTime(new Date("2026-10-03T00:04:00Z"));
    cms.forRelease();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("is a loader over the fallback alone when site is unset or empty", async () => {
    const fallback = bundled();
    for (const loader of [remoteLoader(fallback, { site: "" }), remoteLoader(fallback, {})]) {
      expect(await loader.load()).toBe(fallback);
      expect(loader.update).toBeUndefined();
    }
  });
});
